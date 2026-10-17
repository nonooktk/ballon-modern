-- デモ用リセット: 本人の明示操作で、自分の記録・点・レベルをすべて消して Lv1・0 点に戻す。
-- 「点は減らない」の唯一の例外（統括決定 2026-10-17。ARCHITECTURE ADR-14）。冪等。
-- records / record_ops には DELETE を拒否するトリガは無い。ballon_api にテーブル権限が無いため、この関数の中だけで消せる。

set role ballon_owner;

-- reset の操作は記録（record）を持たないので、record_id を空にできるようにし、kind に reset を足す
alter table record_ops alter column record_id drop not null;
alter table record_ops drop constraint if exists record_ops_kind_check;
alter table record_ops add constraint record_ops_kind_check
  check (kind in ('press', 'revive', 'cancel', 'confirm', 'noop', 'reset'));
alter table record_ops drop constraint if exists record_ops_record_required_check;
alter table record_ops add constraint record_ops_record_required_check
  check (record_id is not null or kind = 'reset');

create or replace function app_reset_me(p_user uuid, p_op uuid) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_op      record_ops%rowtype;
  v_deleted integer;
begin
  if p_user is null or p_op is null then
    return _err('bad_request');
  end if;
  perform _lock(p_user);
  if not exists (select 1 from users where id = p_user) then
    return _err('unauthorized');
  end if;

  select * into v_op from record_ops where user_id = p_user and op_id = p_op;
  if found then
    -- 同じ操作 ID の再送: 何も消さない
    if v_op.kind <> 'reset' then
      return _err('op_conflict');
    end if;
    return jsonb_build_object('status', 'ok', 'deleted', 0, 'progress', _progress(p_user));
  end if;

  -- この利用者の行だけを消す（record_ops は records への外部キーでも消えるが、明示して全件消す）
  delete from record_ops where user_id = p_user;
  delete from records where user_id = p_user;
  get diagnostics v_deleted = row_count;
  insert into record_ops (user_id, op_id, record_id, kind, local_date, points)
    values (p_user, p_op, null, 'reset', current_date, 0);
  return jsonb_build_object('status', 'ok', 'deleted', v_deleted, 'progress', _progress(p_user));
end
$$;

revoke all on function app_reset_me(uuid, uuid) from public;
grant execute on function app_reset_me(uuid, uuid) to ballon_api;

reset role;
