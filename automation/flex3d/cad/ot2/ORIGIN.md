# Existing OT-2 runtime assets

Reused from LabScript-AI webdemo renderer, commit f4d0d5910473dc1af1f0cd3b15f6448cbdb16004; original modelling sources are maintained in virtual-lab. The isolated sim/ot2_runtime package preserves the accepted model and planner, with local imports and writable export paths adapted to this plugin. This integration does not rebuild the OT-2 or register a second BioRehearse asset.

Deck/module definitions originate from Opentrons shared-data 8.8.2; reference STL models originate from Opentrons. Official deck coordinates are retained; visible enclosure, pipette skins and module details include engineering estimates. Required research attribution: Gao, Yuan et al., “Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering,” bioRxiv (2025), https://doi.org/10.1101/2025.09.30.679666. See repository LICENSE and CITATION.cff.

Modules in this accepted runtime: Magnetic V1/V2, Temperature V1/V2, Thermocycler V1. Heater-Shaker and newer module models are not added by this migration. Partial nozzle layouts and manual labware relocation are not supported. Thermal/motion durations are illustrative, explicit waits/holds are retained. Geometry checks sample model envelopes; they do not certify continuous physical clearance or robot calibration.
