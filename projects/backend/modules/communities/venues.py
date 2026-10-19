"""Match a feed's venue text to an in-town branch by normalised name or street address."""

import re

NAME_NOISE = {"the", "branch", "library", "public", "and"}
ADDRESS_WORDS = {
    "avenue": "ave", "av": "ave", "street": "st", "drive": "dr", "road": "rd",
    "boulevard": "blvd", "place": "pl", "court": "ct", "lane": "ln", "parkway": "pkwy",
    "highway": "hwy", "terrace": "ter", "square": "sq",
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
    "first": "1st", "second": "2nd", "third": "3rd", "fourth": "4th", "fifth": "5th",
    "sixth": "6th", "seventh": "7th", "eighth": "8th", "ninth": "9th", "tenth": "10th",
}  # fmt: skip


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def name_key(text: str) -> str:
    return " ".join(token for token in _tokens(text) if token not in NAME_NOISE)


def address_key(text: str) -> str:
    return " ".join(ADDRESS_WORDS.get(token, token) for token in _tokens(text))


def match_branch(venue: str, branches: list[dict]) -> str | None:
    """Return the matching branch name, or None. Exact normalised equality only."""
    segments = [venue, *venue.split(",")]
    names = {name_key(segment) for segment in segments} - {""}
    address = f" {address_key(venue)} "
    for branch in branches:
        if name_key(branch["name"]) in names:
            return branch["name"]
        street = address_key(branch["address"])
        if street and f" {street} " in address:
            return branch["name"]
    return None
