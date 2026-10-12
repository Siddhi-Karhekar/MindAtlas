import Logo from "./Logo.jsx";

// The centred card the sign-in pages share: forgot password, reset password,
// confirm email.
export default function AuthCard({ title, children }) {
  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-gutter-canvas py-space-xl">
      <div className="w-full max-w-[440px] bg-surface-container-lowest rounded-xl shadow-xl p-space-xl sm:p-space-2xl flex flex-col gap-space-md">
        <div className="flex flex-col items-center text-center gap-space-xs">
          <div className="w-12 h-12 rounded-xl bg-surface-container-low flex items-center justify-center shadow-sm">
            <Logo size={30} />
          </div>
          <h1 className="font-headline-sm text-headline-sm text-on-surface tracking-tight">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

export const authInput =
  "w-full h-11 px-space-base rounded-lg bg-surface-container-low text-on-surface font-ui-body text-ui-body placeholder:text-on-surface-variant/50 shadow-sm focus:outline-none focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary/20 transition-all";
export const authButton =
  "w-full h-11 rounded-lg bg-primary hover:opacity-90 text-on-primary font-ui-title text-ui-title tracking-tight shadow-md transition-all flex items-center justify-center gap-space-xs disabled:opacity-60";
export const authLink = "font-label-md text-label-md text-primary hover:text-on-surface-variant font-semibold";
