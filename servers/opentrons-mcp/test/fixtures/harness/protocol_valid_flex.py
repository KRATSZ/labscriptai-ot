from opentrons import protocol_api

metadata = {
    "protocolName": "Harness Valid Flex Noop",
    "author": "harness",
    "description": "Low-risk Flex protocol used by the LLM agent harness as a known-good simulate target.",
}

requirements = {"robotType": "Flex", "apiLevel": "2.22"}


def run(protocol: protocol_api.ProtocolContext) -> None:
    protocol.comment("harness valid protocol start")
    protocol.comment("harness valid protocol end")
