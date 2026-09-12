# Security notes

## The sign-in gate restricts the UI, not the data

`isAuthorizedEmail()` runs in the browser and can be bypassed by anyone with
developer tools. It is a convenience, not an access control.

The real boundary is Microsoft Graph: the app requests `Files.ReadWrite` against
`me/drive`, so each signed-in account can only ever reach its own OneDrive files.
Do not add anything to this app that assumes the email allowlist is enforcement.

A consequence worth stating plainly: quotes are stored per-user. Two estimators
signing in with different accounts do not share a quote library.

## Third-party scripts need SRI pinning

`index.html` loads four libraries from CDNs (SheetJS, jsPDF, jspdf-autotable,
MSAL). They execute with full access to the page, including the Graph access
token. A compromised CDN, or a hijacked subdomain, can serve different code.

Run `./tools/add-sri.sh` to add `integrity` hashes. The tags already carry
`crossorigin="anonymous"`, which SRI requires.

This has **not** been done in the committed file: the environment these changes
were made in has no network access to cdnjs, and guessing a hash is worse than
having none — a wrong hash blocks the script and the app silently fails to load.

## Reporting

Contact info@jmcengg.com.
