export default function AuthScreen({
  loading,
  mode,
  username,
  password,
  passwordConfirmation,
  error,
  submitting,
  onModeChange,
  onUsernameChange,
  onPasswordChange,
  onPasswordConfirmationChange,
  onSignIn,
  onSignUp,
}) {
  if (loading) {
    return (
      <main className="app">
        <div className="auth-panel">
          <h1>Checking authentication...</h1>
          <p>Please wait while we verify your session.</p>
        </div>
      </main>
    );
  }

  const isSignIn = mode === "signin";
  const switchMode = () => onModeChange(isSignIn ? "signup" : "signin");

  return (
    <main className="app">
      <section className="auth-panel">
        <h1>{isSignIn ? "Sign in to continue" : "Create your account"}</h1>
        <p className="subtitle">
          Enter your credentials to access the catalog integration console.
        </p>
        <form className="login-form" onSubmit={isSignIn ? onSignIn : onSignUp}>
          <label>
            Username
            <input type="text" value={username}
              onChange={(event) => onUsernameChange(event.target.value)}
              disabled={submitting} minLength={isSignIn ? undefined : 3}
              maxLength={50} required />
          </label>
          <label>
            Password
            <input type="password" value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              disabled={submitting} minLength={isSignIn ? undefined : 8}
              maxLength={128} required />
          </label>
          {!isSignIn && (
            <label>
              Confirm password
              <input type="password" value={passwordConfirmation}
                onChange={(event) => onPasswordConfirmationChange(event.target.value)}
                disabled={submitting} minLength={8} maxLength={128} required />
            </label>
          )}
          {error && <p className="status error">{error}</p>}
          <button type="submit" className="refresh-btn" disabled={submitting}>
            {submitting
              ? isSignIn ? "Signing in..." : "Creating account..."
              : isSignIn ? "Sign in" : "Create account"}
          </button>
          <p className="auth-switch-prompt">
            {isSignIn ? "Don't have an account?" : "Already have an account?"}{" "}
            <button type="button" className="auth-switch-link"
              disabled={submitting} onClick={switchMode}>
              {isSignIn ? "Sign up" : "Sign in"}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}
