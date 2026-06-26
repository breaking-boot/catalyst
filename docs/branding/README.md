# Catalyst Branding Assets

This directory contains source and master branding assets for Catalyst.

Catalyst is an unofficial Chrome extension for Boot.dev. The visual direction uses a clean chemistry/progress theme: a flask, blue catalyst crystal, gold spark, dark navy/charcoal badge, and gold ring.

The branding should stay public-friendly and should not imply official Boot.dev affiliation. It should also avoid copying Boot.dev or Breaking Bad branding.

## Directory purpose

Files in this directory are for human/reference use, such as README images, GitHub release assets, design notes, and future icon generation.

These files are not loaded directly by the Chrome extension.

## Runtime icon locations

Chrome-facing extension icons belong here:

```text
bootdev-extension/icons/icon16.png
bootdev-extension/icons/icon32.png
bootdev-extension/icons/icon48.png
bootdev-extension/icons/icon128.png
```

Runtime images used by the extension UI belong here:

```text
bootdev-extension/assets/
```

Master/source branding files belong here:

```text
docs/branding/
```

## Icon export guidance

When generating Chrome extension icons from the master logo:

* Export PNG files with transparent backgrounds.
* Keep the visible artwork circular, but leave the canvas square.
* Do not bake in a black square background.
* Keep the flask, crystal, and spark readable at small sizes.
* Simplify details aggressively for `16x16` and `32x32`.
* Use the more detailed master logo for README, GitHub, and release imagery.

Expected visible shape:

```text
transparent square canvas
└── circular badge artwork
    └── transparent corners
```

Avoid this:

```text
opaque black square canvas
└── circular badge artwork
```

## Design direction

Preferred visual elements:

* dark navy/charcoal circular badge
* gold outer ring
* chemistry flask silhouette
* glowing cyan/blue catalyst crystal
* gold spark or reaction arc
* polished, readable, extension-friendly silhouette

Avoid:

* Boot.dev logo copies
* Breaking Bad logo copies
* illicit/drug-themed visuals
* excessive small bubbles or micro-details
* text inside toolbar icon files

## File naming

Use descriptive names for master/reference assets, for example:

```text
catalyst-logo-master.png
catalyst-icon-master.png
catalyst-readme-logo.png
```

Generated Chrome extension icons should keep the fixed filenames expected by `manifest.json`:

```text
icon16.png
icon32.png
icon48.png
icon128.png
```

## Manifest wiring

The extension manifest should reference the Chrome-facing icons from `bootdev-extension/icons/`, not this directory.

Both top-level `icons` and `action.default_icon` should point to the exported runtime icons.

Example:

```json
{
  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "action": {
    "default_title": "Catalyst for Boot.dev",
    "default_icon": {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  }
}
```
