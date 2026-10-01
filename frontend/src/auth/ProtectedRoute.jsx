import { useAuth } from "./AuthContext";
import AuthPage from "./AuthPage";

export default function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-nv-400/30 border-t-nv-400 rounded-full animate-spin mx-auto mb-3" />
          <div className="text-sm text-zinc-500">Checking session…</div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthPage />;
  }

  return children;
}
