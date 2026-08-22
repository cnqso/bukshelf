import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type as osType } from '@tauri-apps/plugin-os';

export interface AuthRequest {
  authUrl: string;
  /** iOS ASWebAuthenticationSession callback scheme. */
  callbackScheme?: string;
}

export interface CustomTabAuthRequest extends AuthRequest {
  /** Exact custom-scheme URI Android must accept for this authorization attempt. */
  callbackUrl: string;
}

export interface AuthResponse {
  redirectUrl: string;
}

export async function authWithSafari(request: AuthRequest): Promise<AuthResponse> {
  const OS_TYPE = osType();
  if (OS_TYPE === 'ios') {
    return invoke<AuthResponse>('plugin:native-bridge|auth_with_safari', {
      payload: request,
    });
  }
  if (OS_TYPE === 'macos') {
    return new Promise<AuthResponse>(async (resolve, reject) => {
      const unlistenComplete = await listen<AuthResponse>('safari-auth-complete', ({ payload }) => {
        cleanup();
        resolve(payload);
      });

      function cleanup() {
        unlistenComplete();
      }

      try {
        await invoke<AuthResponse>('auth_with_safari', { payload: request });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }
  throw new Error('Unsupported OS type');
}

export async function authWithCustomTab(request: CustomTabAuthRequest): Promise<AuthResponse> {
  return invoke<AuthResponse>('plugin:native-bridge|auth_with_custom_tab', {
    payload: request,
  });
}
