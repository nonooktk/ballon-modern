-- ふうせん（ballon-modern）初期マイグレーション
-- 設計: 02_プロジェクト/ballon-modern/ARCHITECTURE.md §4 と DB動きレビュー資料.md
--
-- ・管理用ロール（CREATEROLE が使えるもの）で流す。何度流しても同じ結果になる（冪等）。
-- ・オブジェクトの所有者は ballon_owner。API は ballon_api で接続し、関数の実行だけができる。
-- ・ballon_api のパスワードはこのファイルに書かない。管理者が別途 `alter role ballon_api password '...'` で設定する。
-- ・apply.sh は psql -1（1 トランザクション）で流す。

-- ---------------------------------------------------------------------------
-- 1. ロールと権限の土台
-- ---------------------------------------------------------------------------
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'ballon_owner') then
    create role ballon_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ballon_api') then
    create role ballon_api login nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  -- 管理用ロールが ballon_owner に切り替えられるようにする（スーパーユーザーなら不要。失敗しても続ける）
  begin
    execute format('grant ballon_owner to %I', current_user);
  exception when others then
    raise notice 'grant ballon_owner to current_user をスキップ: %', sqlerrm;
  end;
end
$roles$;

-- この DB への接続を ballon_owner / ballon_api だけにする（他の DB には触れない設定のため、この DB の範囲だけ）
do $conn$
begin
  execute format('revoke connect on database %I from public', current_database());
  execute format('grant connect on database %I to ballon_owner, ballon_api', current_database());
end
$conn$;

revoke all on schema public from public;
grant usage on schema public to ballon_api;
grant usage, create on schema public to ballon_owner;

-- 関数は既定で全員に実行権限が付く。ballon_owner が作る関数の既定を外す。
-- （IN SCHEMA を付けない全体の既定を外す。スキーマ限定の revoke では既定の PUBLIC 権限は消えない）
alter default privileges for role ballon_owner revoke execute on functions from public;
alter default privileges for role ballon_owner in schema public revoke execute on functions from public;

set role ballon_owner;

-- ---------------------------------------------------------------------------
-- 2. テーブル 6 つ
-- ---------------------------------------------------------------------------
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  google_sub  text not null unique,
  email       text not null,
  created_at  timestamptz not null default now()
);

create table if not exists action_defs (
  id          text primary key,
  label       text not null,
  icon        text not null,
  frequency   text not null check (frequency in ('daily_once', 'repeatable')),
  detail      text not null check (detail in ('none', 'weight', 'meal')),
  is_active   boolean not null default true,
  sort_order  smallint not null           -- 小さい行為の並び（時間帯の大 3 つの並びは action_bands）
);

create table if not exists action_bands (
  band       text not null check (band in ('morning', 'noon', 'night')),
  position   smallint not null check (position between 1 and 3),
  action_id  text not null references action_defs(id),
  primary key (band, position),
  unique (band, action_id)
);

create table if not exists level_table (
  level            smallint primary key check (level >= 1),
  required_points  integer not null check (required_points > 0 and required_points % 10 = 0)
);

create table if not exists records (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  action_id      text not null references action_defs(id),
  local_date     date not null,
  slot_date      date,
  press_points   smallint not null default 10 check (press_points in (0, 10)),
  confirm_points smallint not null default 0  check (confirm_points in (0, 20)),
  weight_kg      numeric(4,1) check (weight_kg between 20.0 and 300.0),
  portion        text check (portion in ('small', 'normal', 'large')),
  cancelled_at   timestamptz,
  active_since   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (user_id, action_id, slot_date),
  check (weight_kg is null or portion is null),
  check ((weight_kg is null and portion is null) or confirm_points > 0),
  check (slot_date is null or slot_date = local_date)
);
create index if not exists records_user_date_idx on records (user_id, local_date);

create table if not exists record_ops (
  user_id    uuid not null references users(id) on delete cascade,
  op_id      uuid not null,
  record_id  uuid not null references records(id) on delete cascade,
  kind       text not null check (kind in ('press', 'revive', 'cancel', 'confirm', 'noop')),
  local_date date not null,
  points     smallint not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, op_id)
);
create index if not exists record_ops_user_date_idx on record_ops (user_id, local_date);

-- ---------------------------------------------------------------------------
-- 3. トリガ（最後の守り）
-- ---------------------------------------------------------------------------

-- records: 行為の種類と列の整合、点を減らす更新・不変の列の更新の拒否
create or replace function trg_records_guard() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  d action_defs%rowtype;
begin
  select * into d from action_defs where id = new.action_id;
  if not found then
    raise exception 'action_id が存在しません' using errcode = '23503';
  end if;
  if (d.frequency = 'daily_once') <> (new.slot_date is not null) then
    raise exception 'slot_date と frequency が合いません' using errcode = '23514';
  end if;
  if d.detail = 'none' and (new.confirm_points <> 0 or new.weight_kg is not null or new.portion is not null) then
    raise exception 'detail=none の行に確定の点・値は入れられません' using errcode = '23514';
  end if;
  if d.detail = 'weight' and new.portion is not null then
    raise exception 'detail=weight の行に量は入れられません' using errcode = '23514';
  end if;
  if d.detail = 'meal' and new.weight_kg is not null then
    raise exception 'detail=meal の行に体重は入れられません' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.press_points < old.press_points or new.confirm_points < old.confirm_points then
      raise exception '点を減らす更新はできません' using errcode = '23514';
    end if;
    if (new.id, new.user_id, new.action_id, new.local_date, new.slot_date, new.created_at)
       is distinct from (old.id, old.user_id, old.action_id, old.local_date, old.slot_date, old.created_at) then
      raise exception '変えられない列の更新はできません' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
drop trigger if exists records_guard on records;
create trigger records_guard before insert or update on records
  for each row execute function trg_records_guard();

-- action_defs: 削除不可。記録がある行為の frequency / detail の変更は拒否（同じ値は通る）
create or replace function trg_action_defs_guard() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '行為は削除できません（is_active=false で無効にする）' using errcode = '23514';
  end if;
  if new.id <> old.id then
    raise exception '行為の id は変えられません' using errcode = '23514';
  end if;
  if (new.frequency <> old.frequency or new.detail <> old.detail)
     and exists (select 1 from records where action_id = old.id) then
    raise exception '記録がある行為の frequency / detail は変えられません（新しい id で作る）' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists action_defs_guard on action_defs;
create trigger action_defs_guard before update or delete on action_defs
  for each row execute function trg_action_defs_guard();

-- level_table: 必要点は下げる更新だけ許可（上げるとすでに上がったレベルが下がりうる）。削除不可
create or replace function trg_level_table_guard() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'レベル表の行は削除できません' using errcode = '23514';
  end if;
  if new.level <> old.level then
    raise exception 'level は変えられません' using errcode = '23514';
  end if;
  if new.required_points > old.required_points then
    raise exception '必要点を上げる更新はできません（切り替え手順は DB動きレビュー資料 視点 3 ②）' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists level_table_guard on level_table;
create trigger level_table_guard before update or delete on level_table
  for each row execute function trg_level_table_guard();

-- ---------------------------------------------------------------------------
-- 4. 内部の補助関数（ballon_api には実行権限を与えない）
-- ---------------------------------------------------------------------------

-- 1 日の上限（repeatable の行数・台帳の行数）。テストで差し替えられるよう関数にしてある
create or replace function _daily_cap() returns integer
language sql stable
as $$ select 600 $$;

-- 取り消しの期限（最後に有効になってから）
create or replace function _cancel_window() returns interval
language sql stable
as $$ select interval '10 minutes' $$;

create or replace function _lock(p_user uuid) returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('ballon:' || p_user::text, 0));
end
$$;

create or replace function _err(p_code text) returns jsonb
language sql immutable
as $$ select jsonb_build_object('status', 'error', 'error', p_code) $$;

-- 点の合計とレベル。累計は取り消した行も含めて数える（行数の上限で切れない集計）
create or replace function _progress(p_user uuid) returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_total bigint;
  v_level integer;
  v_req   integer;
  v_cum   bigint;
  v_max   boolean := false;
begin
  select coalesce(sum(press_points + confirm_points), 0) into v_total
    from records where user_id = p_user;

  select t.level, t.required_points, t.cum into v_level, v_req, v_cum
    from (select level, required_points,
                 sum(required_points) over (order by level) as cum
            from level_table) t
   where v_total < t.cum
   order by t.level
   limit 1;

  if not found then
    -- 最大レベルより先は最大レベルで頭打ち
    select t.level, t.required_points, t.cum into v_level, v_req, v_cum
      from (select level, required_points,
                   sum(required_points) over (order by level) as cum
              from level_table) t
     order by t.level desc
     limit 1;
    v_max := true;
  end if;

  return jsonb_build_object(
    'level', v_level,
    'current_points', case when v_max then v_req else v_total - (v_cum - v_req) end,
    'required_points', v_req,
    'remaining_points', case when v_max then 0 else v_cum - v_total end,
    'total_points', v_total,
    'is_max', v_max
  );
end
$$;

create or replace function _confirm_state(p_detail text, p_weight numeric, p_portion text, p_confirm smallint) returns text
language sql immutable
as $$
  select case
    when p_detail = 'none' then 'none'
    when (p_detail = 'weight' and p_weight is not null) or (p_detail = 'meal' and p_portion is not null) then 'done'
    when p_confirm > 0 then 'regrant_blocked'
    else 'open'
  end
$$;

-- 成功時の応答の共通部分。p_before が null のとき（再送）は level_before = level_after
create or replace function _out(p_user uuid, p_rec uuid, p_reason text, p_granted integer, p_before jsonb) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  r records%rowtype;
  d action_defs%rowtype;
  v_prog jsonb;
begin
  select * into r from records where id = p_rec;
  select * into d from action_defs where id = r.action_id;
  v_prog := _progress(p_user);
  return jsonb_build_object(
    'status', 'ok',
    'reason', p_reason,
    'record_id', r.id,
    'granted_points', p_granted,
    'confirm_state', _confirm_state(d.detail, r.weight_kg, r.portion, r.confirm_points),
    'progress', v_prog,
    'level_before', coalesce((p_before ->> 'level')::integer, (v_prog ->> 'level')::integer),
    'level_after', (v_prog ->> 'level')::integer
  );
end
$$;

-- 取り消し・復活・確定・noop の台帳が 1 日の上限に達しているか
create or replace function _ops_capped(p_user uuid, p_date date) returns boolean
language sql stable
set search_path = public, pg_temp
as $$
  select count(*) >= _daily_cap()
    from record_ops
   where user_id = p_user and local_date = p_date
     and kind in ('cancel', 'revive', 'confirm', 'noop')
$$;

-- ---------------------------------------------------------------------------
-- 5. API から呼ぶ関数 7 本（security definer・所有者 ballon_owner）
-- ---------------------------------------------------------------------------

create or replace function app_login(p_google_sub text, p_email text) returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_google_sub is null or p_google_sub = '' then
    raise exception 'google_sub が必要です' using errcode = '22023';
  end if;
  insert into users (google_sub, email) values (p_google_sub, coalesce(p_email, ''))
    on conflict (google_sub) do nothing;
  select id into v_id from users where google_sub = p_google_sub;
  return v_id;
end
$$;

create or replace function app_total(p_user uuid) returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$ select _progress(p_user) $$;

create or replace function app_press(p_user uuid, p_op uuid, p_action text, p_local_date date) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_def    action_defs%rowtype;
  v_op     record_ops%rowtype;
  v_rec    records%rowtype;
  v_before jsonb;
  v_id     uuid;
begin
  if p_user is null or p_op is null or p_action is null or p_local_date is null then
    return _err('bad_request');
  end if;
  perform _lock(p_user);
  if not exists (select 1 from users where id = p_user) then
    return _err('unauthorized');
  end if;

  -- 同じ操作 ID の再送: 何も変えず、その時点の行を返す
  select * into v_op from record_ops where user_id = p_user and op_id = p_op;
  if found then
    if v_op.kind not in ('press', 'revive', 'noop') then
      return _err('op_conflict');
    end if;
    select * into v_rec from records where id = v_op.record_id;
    if v_rec.action_id <> p_action then
      return _err('op_conflict');
    end if;
    return _out(p_user, v_op.record_id, 'replayed', v_op.points, null);
  end if;

  select * into v_def from action_defs where id = p_action;
  if not found then
    return _err('not_found');
  end if;
  if not v_def.is_active then
    return _err('action_inactive');
  end if;

  v_before := _progress(p_user);

  if v_def.frequency = 'daily_once' then
    select * into v_rec from records
     where user_id = p_user and action_id = p_action and slot_date = p_local_date;
    if found then
      if _ops_capped(p_user, p_local_date) then
        return _err('daily_cap');
      end if;
      if v_rec.cancelled_at is null then
        -- 同日 2 回目: 行は増やさず、操作 ID だけ残す（複製が取り消し済みの行を復活させないため）
        insert into record_ops (user_id, op_id, record_id, kind, local_date, points)
          values (p_user, p_op, v_rec.id, 'noop', p_local_date, 0);
        return _out(p_user, v_rec.id, 'already_recorded', 0, v_before);
      end if;
      -- 取り消した同日の押し直し: 点なしで同じ行を戻す。古い値は推移に戻らないよう消す
      update records
         set cancelled_at = null, active_since = now(), weight_kg = null, portion = null
       where id = v_rec.id;
      insert into record_ops (user_id, op_id, record_id, kind, local_date, points)
        values (p_user, p_op, v_rec.id, 'revive', p_local_date, 0);
      return _out(p_user, v_rec.id, 'revived', 0, v_before);
    end if;
  else
    -- repeatable は 1 日の行数に上限（取り消した行を含む）
    if (select count(*) from records r join action_defs a on a.id = r.action_id
         where r.user_id = p_user and r.local_date = p_local_date and a.frequency = 'repeatable')
       >= _daily_cap() then
      return _err('daily_cap');
    end if;
  end if;

  insert into records (user_id, action_id, local_date, slot_date)
    values (p_user, p_action, p_local_date,
            case when v_def.frequency = 'daily_once' then p_local_date end)
    returning id into v_id;
  insert into record_ops (user_id, op_id, record_id, kind, local_date, points)
    values (p_user, p_op, v_id, 'press', p_local_date, 10);
  return _out(p_user, v_id, 'granted', 10, v_before);
end
$$;

create or replace function app_confirm(
  p_user uuid, p_op uuid, p_record uuid, p_weight numeric, p_portion text, p_local_date date
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_op      record_ops%rowtype;
  v_rec     records%rowtype;
  v_def     action_defs%rowtype;
  v_before  jsonb;
  v_granted integer := 0;
begin
  if p_user is null or p_op is null or p_record is null or p_local_date is null then
    return _err('bad_request');
  end if;
  perform _lock(p_user);
  if not exists (select 1 from users where id = p_user) then
    return _err('unauthorized');
  end if;

  select * into v_op from record_ops where user_id = p_user and op_id = p_op;
  if found then
    if v_op.kind <> 'confirm' or v_op.record_id <> p_record then
      return _err('op_conflict');
    end if;
    return _out(p_user, p_record, 'replayed', v_op.points, null);
  end if;

  -- 他人の記録も存在しない記録も、同じ not_found（存在の有無を教えない）
  select * into v_rec from records where id = p_record and user_id = p_user;
  if not found then
    return _err('not_found');
  end if;
  if v_rec.cancelled_at is not null then
    return _err('record_cancelled');
  end if;
  select * into v_def from action_defs where id = v_rec.action_id;

  -- 行為の種類と項目の整合（水に量、朝食に体重などは断る）
  if v_def.detail = 'none'
     or (v_def.detail = 'weight' and (p_weight is null or p_portion is not null))
     or (v_def.detail = 'meal' and (p_portion is null or p_weight is not null)) then
    return _err('bad_detail');
  end if;
  if p_weight is not null and (p_weight < 20.0 or p_weight > 300.0 or p_weight <> round(p_weight, 1)) then
    return _err('bad_request');
  end if;
  if p_portion is not null and p_portion not in ('small', 'normal', 'large') then
    return _err('bad_request');
  end if;
  -- 確定できるのは当日と前日の記録（0 時をまたぐ確定を救う）
  if v_rec.local_date < p_local_date - 1 then
    return _err('confirm_expired');
  end if;
  if _ops_capped(p_user, p_local_date) then
    return _err('daily_cap');
  end if;

  v_before := _progress(p_user);
  if v_rec.confirm_points = 0 then
    v_granted := 20;   -- +20 は一度だけ。取り消し・復活をまたいでも二度付かない
  end if;
  update records
     set weight_kg = p_weight, portion = p_portion, confirm_points = confirm_points + v_granted
   where id = v_rec.id;
  insert into record_ops (user_id, op_id, record_id, kind, local_date, points)
    values (p_user, p_op, v_rec.id, 'confirm', p_local_date, v_granted);
  return _out(p_user, v_rec.id, 'confirmed', v_granted, v_before);
end
$$;

create or replace function app_cancel(p_user uuid, p_op uuid, p_record uuid) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_op  record_ops%rowtype;
  v_rec records%rowtype;
begin
  if p_user is null or p_op is null or p_record is null then
    return _err('bad_request');
  end if;
  perform _lock(p_user);
  if not exists (select 1 from users where id = p_user) then
    return _err('unauthorized');
  end if;

  select * into v_op from record_ops where user_id = p_user and op_id = p_op;
  if found then
    if v_op.kind <> 'cancel' or v_op.record_id <> p_record then
      return _err('op_conflict');
    end if;
    return jsonb_build_object('status', 'ok', 'record_id', p_record, 'cancelled', true,
                              'progress', _progress(p_user));
  end if;

  select * into v_rec from records where id = p_record and user_id = p_user;
  if not found then
    return _err('not_found');
  end if;
  if _ops_capped(p_user, v_rec.local_date) then
    return _err('daily_cap');
  end if;

  if v_rec.cancelled_at is null then
    if now() - v_rec.active_since > _cancel_window() then
      return _err('cancel_expired');
    end if;
    update records set cancelled_at = now() where id = v_rec.id;
  end if;
  -- すでに取り消し済みでも、期限を見ずに成功を返す。操作 ID は残す（復活のあとに複製が届いても覆さないため）
  insert into record_ops (user_id, op_id, record_id, kind, local_date, points)
    values (p_user, p_op, v_rec.id, 'cancel', v_rec.local_date, 0);
  return jsonb_build_object('status', 'ok', 'record_id', v_rec.id, 'cancelled', true,
                            'progress', _progress(p_user));
end
$$;

create or replace function app_home_state(p_user uuid, p_local_date date) returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'progress', _progress(p_user),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'label', d.label, 'icon', d.icon,
               'frequency', d.frequency, 'detail', d.detail,
               'count', t.cnt, 'record_id', t.rec_id,
               'confirm_state', case when t.rec_id is null then 'none'
                                     else _confirm_state(d.detail, t.w, t.p, t.cp) end
             ) order by d.sort_order, d.id)
        from action_defs d
        left join lateral (
          select count(*)::integer as cnt,
                 (array_agg(r.id order by r.active_since desc, r.created_at desc))[1] as rec_id,
                 (array_agg(r.weight_kg order by r.active_since desc, r.created_at desc))[1] as w,
                 (array_agg(r.portion order by r.active_since desc, r.created_at desc))[1] as p,
                 (array_agg(r.confirm_points order by r.active_since desc, r.created_at desc))[1] as cp
            from records r
           where r.user_id = p_user and r.action_id = d.id
             and r.local_date = p_local_date and r.cancelled_at is null
        ) t on true
       where d.is_active
    ), '[]'::jsonb),
    'bands', jsonb_build_object(
      'morning', coalesce((select jsonb_agg(b.action_id order by b.position)
                             from action_bands b join action_defs a on a.id = b.action_id
                            where b.band = 'morning' and a.is_active), '[]'::jsonb),
      'noon',    coalesce((select jsonb_agg(b.action_id order by b.position)
                             from action_bands b join action_defs a on a.id = b.action_id
                            where b.band = 'noon' and a.is_active), '[]'::jsonb),
      'night',   coalesce((select jsonb_agg(b.action_id order by b.position)
                             from action_bands b join action_defs a on a.id = b.action_id
                            where b.band = 'night' and a.is_active), '[]'::jsonb)
    ),
    'last_weight_kg', (
      select r.weight_kg
        from records r join action_defs a on a.id = r.action_id
       where r.user_id = p_user and a.detail = 'weight'
         and r.cancelled_at is null and r.weight_kg is not null
       order by r.local_date desc, r.active_since desc
       limit 1
    )
  )
$$;

-- 推移の材料: 取り消されていない体重を日ごとに平均して 34 日ぶん返す（平均の計算は API）
create or replace function app_trend(p_user uuid, p_local_date date) returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('points', coalesce(jsonb_agg(
           jsonb_build_object('date', x.d, 'kg', x.k) order by x.d), '[]'::jsonb))
    from (
      select r.local_date as d, avg(r.weight_kg) as k
        from records r join action_defs a on a.id = r.action_id
       where r.user_id = p_user and a.detail = 'weight'
         and r.cancelled_at is null and r.weight_kg is not null
         and r.local_date between p_local_date - 33 and p_local_date
       group by r.local_date
    ) x
$$;

-- ---------------------------------------------------------------------------
-- 6. 権限: ballon_api は 7 関数の実行だけ。テーブルには何も与えない
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from public;
revoke all on all functions in schema public from public;

grant execute on function app_login(text, text) to ballon_api;
grant execute on function app_total(uuid) to ballon_api;
grant execute on function app_press(uuid, uuid, text, date) to ballon_api;
grant execute on function app_confirm(uuid, uuid, uuid, numeric, text, date) to ballon_api;
grant execute on function app_cancel(uuid, uuid, uuid) to ballon_api;
grant execute on function app_home_state(uuid, date) to ballon_api;
grant execute on function app_trend(uuid, date) to ballon_api;

-- ---------------------------------------------------------------------------
-- 7. 初期データ（冪等）
-- ---------------------------------------------------------------------------
-- frequency / detail は upsert で更新しない（記録がある行為では変えられないため）
insert into action_defs (id, label, icon, frequency, detail, sort_order) values
  ('weight',    '体重をはかった', '⚖️', 'daily_once', 'weight', 10),
  ('breakfast', '朝食を食べた',   '🍳', 'daily_once', 'meal',   20),
  ('water',     '水を飲んだ',     '💧', 'repeatable', 'none',   30),
  ('lunch',     '昼食を食べた',   '🍙', 'daily_once', 'meal',   40),
  ('walk',      '歩いた',         '👟', 'repeatable', 'none',   50),
  ('stairs',    '階段を使った',   '🪜', 'repeatable', 'none',   60),
  ('dinner',    '夕食を食べた',   '🍱', 'daily_once', 'meal',   70),
  ('no_snack',  '夜食なしで寝る', '🌙', 'daily_once', 'none',   80),
  ('veggie',    '野菜を先に',     '🥗', 'daily_once', 'none',   90)
on conflict (id) do update
  set label = excluded.label, icon = excluded.icon, sort_order = excluded.sort_order;

-- 時間帯の大 3 つ。野菜を先には入れない（常に小側）
insert into action_bands (band, position, action_id) values
  ('morning', 1, 'weight'),    ('morning', 2, 'breakfast'), ('morning', 3, 'water'),
  ('noon',    1, 'lunch'),     ('noon',    2, 'walk'),      ('noon',    3, 'stairs'),
  ('night',   1, 'dinner'),    ('night',   2, 'no_snack'),  ('night',   3, 'weight')
on conflict (band, position) do nothing;

-- Lv1〜Lv40 の必要点（値の列挙。四捨五入は計算せず固定。Lv8=330）
insert into level_table (level, required_points) values
  (1, 50),   (2, 60),   (3, 80),   (4, 110),  (5, 140),  (6, 190),  (7, 250),  (8, 330),  (9, 430),  (10, 560),
  (11, 730), (12, 950), (13, 1240), (14, 1610), (15, 2090), (16, 2720), (17, 3540), (18, 4600), (19, 5980), (20, 7770),
  (21, 10100), (22, 13130), (23, 17070), (24, 22190), (25, 28850), (26, 37510), (27, 48760), (28, 63390), (29, 82410), (30, 107130),
  (31, 139270), (32, 181050), (33, 235370), (34, 305980), (35, 397770), (36, 517100), (37, 672230), (38, 873900), (39, 1136070), (40, 1476890)
on conflict (level) do nothing;

reset role;
