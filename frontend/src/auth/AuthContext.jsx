import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { setAccessToken as setClientToken, clearAccessToken } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const applyToken = useCallback((token, userData) => {
    setAccessToken(token);
    setClientToken(token);
    setUser(userData);
  }, []);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    clearAccessToken();
  }, []);

  const fetchMe = useCallback(async (token) => {
    const res = await fetch("/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Failed to fetch user");
    return res.json();
  }, []);

  const silentRefresh = useCallback(async () => {
    try {
      const res = await fetch("/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Refresh failed");
      const { access_token } = await res.json();
      const userData = await fetchMe(access_token);
      applyToken(access_token, userData);
      return true;
    } catch {
      clearSession();
      return false;
    }
  }, [applyToken, clearSession, fetchMe]);

  // On mount: handle Google OAuth fragment or restore session from cookie
  useEffect(() => {
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.slice(1));
    const fragmentToken = params.get("access_token");

    if (fragmentToken) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      fetchMe(fragmentToken)
        .then((userData) => applyToken(fragmentToken, userData))
        .catch(clearSession)
        .finally(() => setIsLoading(false));
    } else {
      silentRefresh().finally(() => setIsLoading(false));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const logout = useCallback(async () => {
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "include" });
    } catch {}
    clearSession();
  }, [clearSession]);

  const logoutAll = useCallback(async () => {
    try {
      await fetch("/auth/logout-all", {
        method: "POST",
        credentials: "include",
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
    } catch {}
    clearSession();
  }, [accessToken, clearSession]);

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        isAuthenticated: !!user,
        isLoading,
        applyToken,
        silentRefresh,
        logout,
        logoutAll,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};
