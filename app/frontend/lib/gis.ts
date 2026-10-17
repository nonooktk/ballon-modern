// Google Identity Services（https://accounts.google.com/gsi/client）の読み込みと型。
// 外部の読み込みはこのスクリプトだけ。

export interface CredentialResponse {
  credential: string;
}
interface GsiId {
  initialize(cfg: {
    client_id: string;
    callback: (r: CredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    use_fedcm_for_prompt?: boolean;
    itp_support?: boolean;
  }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
  prompt(): void;
  cancel(): void;
  disableAutoSelect(): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GsiId } };
  }
}

const SRC = "https://accounts.google.com/gsi/client";
let loading: Promise<GsiId> | null = null;

export function loadGis(): Promise<GsiId> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (loading) return loading;
  loading = new Promise<GsiId>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      const id = window.google?.accounts?.id;
      if (id) resolve(id);
      else { loading = null; reject(new Error("gis")); }
    };
    s.onerror = () => { loading = null; s.remove(); reject(new Error("gis")); };
    document.head.appendChild(s);
  });
  return loading;
}
