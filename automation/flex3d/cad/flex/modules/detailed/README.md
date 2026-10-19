# Flex module detail pack

This portable pack provides the five photo-reconstructed Flex module models used by the optional MuJoCo detail renderer. The root `manifest.json` describes millimetre-local groups, joints, and mesh parts; runtime OBJ files are loaded relative to this folder. The per-model `.blend` files are editable authoring sources. Rebuild all module exports with `blender --background --python automation/flex3d/blender/build_flex_modules.py -- --export-only`. GLB exports use metres, while OBJ and STL use millimetres.

The plugin works without this pack and falls back to its primitive module fixtures. To use the detailed models, keep this directory in place or set `FLEX3D_MODULE_ASSETS` to this directory (or its `manifest.json`). No machine-specific paths are used.

Model detail comes from project-authored geometry informed by official module envelopes and photographs. It is not manufacturer CAD or metrology. Hinge, latch, and removable-lid motion is illustrative and not calibrated on hardware. Temperature displays are dark because the player has no telemetry. The model does not simulate temperature, vibration, or optical measurement. Coarse group-5 collision proxies remain separate from visual meshes; the thermocycler lid collision proxy follows its hinge.

Reference images retain their original rights and are not included. Module definitions and documentation are cited in `manifest.json` provenance.
