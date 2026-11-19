const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for use in HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Headers for every HTML page the provider serves, ours and the ones oidc-provider renders through
 * our templates. No scripts at all. Not for oidc-provider's auto-submit pages, which need theirs.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** What to call a client on our pages: its client_name, else its client_id. */
export function appNameOf(
  client: { clientId: string; clientName?: string } | undefined,
): string | undefined {
  if (client === undefined) return undefined;
  return client.clientName === undefined || client.clientName === ""
    ? client.clientId
    : client.clientName;
}

// Colors from the Interledger test wallet. Inline because the CSP allows nothing else.
const STYLE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
font-size:16px;line-height:1.5;color:#040607;
background:linear-gradient(135deg,#d8eeec 0%,#a0d5d5 55%,#36b3b0 100%) fixed}
.card{width:100%;max-width:26rem;padding:2rem;background:#fff;border-radius:14px;
box-shadow:0 1px 2px rgba(4,6,7,.06),0 12px 32px rgba(4,6,7,.12)}
.card>:last-child{margin-bottom:0}
.brand{display:flex;align-items:center;gap:.5rem;margin:0 0 1.75rem;font-size:.875rem;font-weight:600}
.mark{width:1.375rem;height:1.375rem;border-radius:6px;background:linear-gradient(135deg,#36b3b0,#da35ba)}
h1{margin:0 0 .375rem;font-size:1.375rem;line-height:1.25;font-weight:650;overflow-wrap:anywhere}
p{margin:0 0 1.25rem;color:#4b5157;font-size:.9375rem;overflow-wrap:anywhere}
p strong{color:#040607;font-weight:600}
label{display:block;margin:0 0 .375rem;font-size:.8125rem;font-weight:600}
input{display:block;width:100%;padding:.6875rem .75rem;font:inherit;font-size:.875rem;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#040607;background:#fff;
border:1px solid #a0d5d5;border-radius:8px}
input::placeholder{color:#8a9197}
input:focus-visible{outline:2px solid #1f7f7c;outline-offset:1px;border-color:#1f7f7c}
input.invalid{border-color:#d0364b}
input.invalid:focus-visible{outline-color:#b4243a;border-color:#b4243a}
.error{margin:.5rem 0 0;color:#b4243a;font-size:.8125rem}
.button{display:block;width:100%;margin:1rem 0 0;padding:.75rem 1rem;font:inherit;font-size:.9375rem;
font-weight:600;text-align:center;overflow-wrap:anywhere;color:#fff;background:#da35ba;border:1px solid #da35ba;border-radius:8px;
cursor:pointer}
.button:hover{background:#c42aa6;border-color:#c42aa6}
.button:focus-visible{outline:2px solid #b0218f;outline-offset:2px}
.button.secondary{margin-top:.5rem;color:#040607;background:#fff;border-color:#cfd8da}
.button.secondary:hover{background:#f3f7f7}
.button.secondary:focus-visible{outline-color:#1f7f7c}
.icon{display:flex;align-items:center;justify-content:center;width:2.5rem;height:2.5rem;margin:0 0 1rem;
border-radius:50%;font-size:1.25rem;font-weight:700}
.icon.ok{background:#d8eeec;color:#1f7f7c}
.icon.alert{background:#fbe3f5;color:#b0218f}
.footer{margin:1.25rem 0 0;text-align:center;font-size:.75rem;color:#6b7177}
@media (max-width:480px){
body{display:block;padding:3rem 0 0;background:#fff linear-gradient(135deg,#d8eeec 0%,#a0d5d5 55%,#36b3b0 100%) no-repeat;
background-size:100% 7rem}
.card{max-width:none;min-height:calc(100vh - 3rem);padding:1.75rem 1.25rem;
border-radius:14px 14px 0 0;box-shadow:none}
}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
<div class="brand"><span class="mark" aria-hidden="true"></span>Open Payments</div>
${body}
</main>
</body>
</html>
`;
}

export type LoginPageOptions = {
  uid: string;
  /** The requesting client, see `appNameOf`. */
  appName: string;
  walletAddress?: string;
  error?: string;
};

/** The wallet address form. Posts back to `/interaction/<uid>`. */
export function renderLoginPage({ uid, appName, walletAddress, error }: LoginPageOptions): string {
  const invalid =
    error === undefined
      ? ""
      : ' class="invalid" aria-invalid="true" aria-describedby="wallet_address_error"';
  const errorHtml =
    error === undefined
      ? ""
      : `\n<p id="wallet_address_error" class="error" role="alert">${escapeHtml(error)}</p>`;
  return page(
    "Sign in",
    `<h1>Welcome</h1>
<p>Sign in to <strong>${escapeHtml(appName)}</strong> with your wallet address. You'll approve it at your wallet.</p>
<form method="post" action="/interaction/${escapeHtml(encodeURIComponent(uid))}">
<label for="wallet_address">Wallet address</label>
<input id="wallet_address" name="wallet_address" type="text" required autofocus autocomplete="off"
 autocapitalize="off" spellcheck="false" placeholder="$ilp.interledger-test.dev/alice" value="${escapeHtml(walletAddress ?? "")}"${invalid}>${errorHtml}
<button type="submit" class="button">Continue</button>
</form>
<p class="footer">Powered by Open Payments</p>`,
  );
}

/** A page with a short message for when the browser can't be sent back to the app. */
export function renderErrorPage(message: string, title = "Something went wrong"): string {
  return page(
    title,
    `<div class="icon alert" aria-hidden="true">!</div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>`,
  );
}

const LOGOUT_WARNING =
  "Also end your sign-in here? If you do, other apps will ask you to approve at your wallet again.";

const END_SIGN_IN_BUTTON =
  '<button type="submit" form="op.logoutForm" name="logout" value="yes" class="button" autofocus>End my sign-in here</button>';

/**
 * oidc-provider's logout confirmation. `form` is its trusted `op.logoutForm` HTML, inserted as is.
 * Both buttons sign out of the app; only "logout=yes" also ends the provider session. Without a
 * known app there's nothing to sign out of but the provider session, so that's the only button.
 */
export function renderLogoutPage({ form, appName }: { form: string; appName?: string }): string {
  if (appName === undefined) {
    return page(
      "Sign out",
      `<h1>Sign out?</h1>
<p>An app is signing you out. This ends your sign-in here too, so other apps will ask you to approve at your wallet again. To stay signed in, close this tab.</p>
${form}
${END_SIGN_IN_BUTTON}`,
    );
  }
  return page(
    "Sign out",
    `<h1>Sign out?</h1>
<p><strong>${escapeHtml(appName)}</strong> is signing you out. ${LOGOUT_WARNING}</p>
${form}
${END_SIGN_IN_BUTTON}
<button type="submit" form="op.logoutForm" class="button secondary">Only sign out of ${escapeHtml(appName)}</button>`,
  );
}

/** Shown after logout when the app gave no post_logout_redirect_uri. */
export function renderSignedOutPage({ appName }: { appName?: string }): string {
  const heading =
    appName === undefined ? "You're signed out" : `You're signed out of ${escapeHtml(appName)}`;
  const text =
    appName === undefined
      ? "You can close this tab."
      : "You're still signed in here, so other apps won't ask you to approve again. You can close this tab.";
  return page(
    "Signed out",
    `<div class="icon ok" aria-hidden="true">&#10003;</div>
<h1>${heading}</h1>
<p>${text}</p>`,
  );
}
