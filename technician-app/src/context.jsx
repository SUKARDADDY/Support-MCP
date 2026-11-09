import { createContext, useContext } from 'react';

// What every screen needs: the core, who is signed in and what they may do, and a way to
// tell the person something (toast) or move them (go, openSession).
export const AppContext = createContext(null);
export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp needs an AppContext');
  return ctx;
};
