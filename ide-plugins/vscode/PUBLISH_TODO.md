# Publish TODO

- [x] Create publisher on VS Code Marketplace  
  - Go: https://marketplace.visualstudio.com/manage
  - Sign in
  - Create publisher named `xl0` if not already exists  
  - Must match `package.json -> publisher`

- [x] Create publish token  
  - Preferred path: go to https://marketplace.visualstudio.com/manage
  - Sign in with same Microsoft account used for publisher `xl0`
  - Open publisher/profile security settings
  - Create Personal Access Token there if UI offers it
  - Fallback official path: go to https://dev.azure.com
  - In Azure DevOps, open User settings → Personal access tokens
  - Create token with:
    - Organization: `All accessible organizations`
    - Scopes: `Custom defined`
    - `Show all scopes`
    - `Marketplace` → `Manage`
  - Copy token immediately and save it securely
  - If auth loops or sign-out redirects happen:
    - Sign out from Microsoft/Azure sessions
    - Retry in incognito/private window
    - Make sure same account is used for Marketplace, Azure DevOps, and `vsce`

- [ ] Check manifest quality  
  Before first publish, worth adding:
  - [x] `icon` (`assets/icon.png`, rendered from `assets/logo.svg`)
  - `galleryBanner`
  - `homepage`
  - `bugs`
  - more complete `README`
  - `keywords`
  - maybe better `categories`

  Not strictly required, but Marketplace page looks weak without them.

- [x] Build/package locally  
  From `ide-plugins/vscode`:
  ```bash
  bun install
  bun run check
  bun run package
  ```
  Result -> `*.vsix`

- [x] Login `vsce` once  
  From `ide-plugins/vscode`:
  ```bash
  npx vsce login xl0
  ```
  Paste PAT.

- [ ] Publish  
  If publishing current version from `package.json`:
  ```bash
  npx vsce publish
  ```
  Or bump + publish in one step:
  ```bash
  npx vsce publish patch
  npx vsce publish minor
  npx vsce publish major
  ```

- [ ] Verify listing  
  - Check Marketplace page
  - Install by ID: `xl0.pi-lovely-ide`
  - Confirm README/rendering/icon/changelog OK

- [ ] Important gotchas  
  - Version must increase every publish.
  - `publisher` must exactly match Marketplace publisher.
  - `engines.vscode` must be valid for target users.
  - `.vscodeignore` controls packaged files. Yours looks sane.
  - Since `main` points to `dist/extension.cjs`, publish depends on prepublish build succeeding.

- [ ] Recommended first-pass polish before publish  
  - [x] add icon file + `icon` field
  - expand `README.md` with install/setup/use
  - add `keywords`
  - maybe add `pricing: "Free"` and `license` already OK

- [ ] Minimal command flow  
  ```bash
  cd ide-plugins/vscode
  bun install
  bun run check
  npx vsce login xl0
  npx vsce publish
  ```
