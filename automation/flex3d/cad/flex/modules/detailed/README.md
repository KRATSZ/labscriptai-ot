# Detailed Flex module models

The release ZIP includes these five photo-reconstructed Flex module models and uses them automatically. The root `manifest.json` describes millimetre-local groups, joints, and mesh parts; runtime OBJ files are loaded relative to this folder. No separate download or configuration is needed.

Keep this directory in place. `FLEX3D_MODULE_ASSETS` is an advanced override for a custom asset directory or manifest; missing unconfigured assets fall back to primitive fixtures. No machine-specific paths are used.

For model development, editable `.blend` sources and the Blender export script live in the source repository and are excluded from the release ZIP. Rebuild there with `blender --background --python automation/flex3d/blender/build_flex_modules.py -- --export-only`. GLB exports use metres; OBJ and STL use millimetres.

Model detail comes from project-authored geometry informed by official module envelopes and photographs. It is not manufacturer CAD or metrology. Hinge, latch, and removable-lid motion is illustrative and not calibrated on hardware. Temperature displays are dark because the player has no telemetry. The model does not simulate temperature, vibration, or optical measurement. Coarse group-5 collision proxies remain separate from visual meshes; the thermocycler lid collision proxy follows its hinge.

Reference images retain their original rights and are not included. Module definitions and documentation are cited in `manifest.json` provenance.
