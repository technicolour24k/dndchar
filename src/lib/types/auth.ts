export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  themeBackgroundColor: string;
  themePanelColor: string;
  themeTextColor: string;
};
