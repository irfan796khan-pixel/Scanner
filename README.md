# Route Sheets

Phone scanner for marked-up route invoice sheets. Photographs each sheet, reads the printed
and handwritten fields, and builds an editable table you copy into chat with `post these`.

## Deploy

1. Put `index.html`, `manifest.json`, `sw.js` and `icon.png` in the repository root.
2. Settings -> Pages -> Source: Deploy from a branch -> `main` / root.
3. Open the published `https://<user>.github.io/<repo>/` URL on the phone.
4. Chrome menu -> Add to Home screen. It then runs as a standalone app.

## First run

Tap **API key** at the bottom and paste an Anthropic API key. It is held in this phone's
local storage only — it is never committed to the repository and is sent nowhere except
`api.anthropic.com`. Change the model in the same dialog if needed.

Camera permission is requested by the site itself, so **Live camera** raises a real Android
prompt and the tap-through-the-pile flow works. **Photograph sheets** and **Choose photos**
need no permission at all.

## Reading failures

Every photo shows a status tag: queued, reading, read, or failed. Failed shots print the
reason. `Last response` at the bottom prints the raw API reply, which names the cause —
authentication, model name, rate limit, or an unreadable photo.
