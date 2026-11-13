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

const STYLE =
  "body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}" +
  "input{width:100%;box-sizing:border-box;padding:.5rem;font-size:1rem}" +
  "button{margin-top:.75rem;padding:.5rem 1rem;font-size:1rem}" +
  ".error{color:#b00020}";

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
${body}
</body>
</html>
`;
}

export type LoginPageOptions = { uid: string; walletAddress?: string; error?: string };

/** The wallet address form. Posts back to `/interaction/<uid>`. */
export function renderLoginPage({ uid, walletAddress, error }: LoginPageOptions): string {
  const errorHtml =
    error === undefined ? "" : `<p class="error" role="alert">${escapeHtml(error)}</p>\n`;
  return page(
    "Sign in",
    `<h1>Sign in with your wallet address</h1>
${errorHtml}<form method="post" action="/interaction/${escapeHtml(encodeURIComponent(uid))}">
<label for="wallet_address">Wallet address</label>
<input id="wallet_address" name="wallet_address" type="text" required autofocus autocomplete="off"
 autocapitalize="off" spellcheck="false" placeholder="$ilp.interledger-test.dev/alice" value="${escapeHtml(walletAddress ?? "")}">
<button type="submit">Continue</button>
</form>`,
  );
}

/** A page with a short message for when the browser can't be sent back to the app. */
export function renderErrorPage(message: string, title = "Something went wrong"): string {
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`);
}
