from opentrons import protocol_api

metadata = {"protocolName": "Probe fixture", "author": "test"}
requirements = {"robotType": "Flex", "apiLevel": "2.24"}


def run(protocol: protocol_api.ProtocolContext) -> None:
    protocol.load_labware("nest_12_reservoir_15ml", "C2")
