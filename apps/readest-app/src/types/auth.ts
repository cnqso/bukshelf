export interface AuthUser {
  id: string;
  email: string;
  aud: 'authenticated';
  role: 'authenticated';
  app_metadata: {
    provider: 'email';
    providers: ['email'];
  };
  user_metadata: Record<string, unknown> & {
    email: string;
    email_verified: true;
    sub: string;
    picture?: string;
    avatar_url?: string;
    full_name?: string;
  };
}
