# Custom presets

Drop `.json` files here to make them appear (first) in the Sound Lab's preset
list. They load only when the Lab is **served over HTTP** (e.g. the dev server
`python -m http.server 8000`). Browsers can't read a local folder from a
`file://` page. On `file://` this folder is simply ignored.

The Lab's **"Save current as preset…"** button downloads a file in exactly this
format. Save it, then move it into this folder.

## File format

Each file is one preset object (an array of objects, or a
`{ "shared_presets": [ … ] }` wrapper, also work):

```json
{
  "name": "My Patch",
  "author": "you",
  "description": "optional notes",
  "value": "<base64 of a ';'-separated list of raw sysex ints, indexed by address>"
}
```

`name` and `value` are required; `author` and `description` are optional.

## Loading

The Lab fetches `index.json` here first if present (a JSON array of filenames,
e.g. `["my-patch.json"]`); otherwise it falls back to the web server's
directory listing. A `value` saved from the Lab is the device's full per-bank
memory dump, so loading it restores the patch exactly (and on a connected
device, writes it to the current bank).
