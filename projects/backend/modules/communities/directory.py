"""Local US public library directory built from the IMLS Public Libraries Survey (PLS).

The survey lists library systems and their outlets (branches) with addresses, but no
websites. It is downloaded on demand into the ignored local data directory.
"""

import csv
import io
import logging
import re
import sqlite3
import zipfile
from contextlib import closing
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)
PLS_URL = "https://imls.gov/sites/default/files/2024-06/pls_fy2022_csv.zip"
PLS_EDITION = "FY2022"
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
# CE = central library, BR = branch. Bookmobiles (BM) and books-by-mail (BS) have no venue.
VENUE_TYPES = ("CE", "BR")
SEARCH_LIMIT = 10


class DirectoryUnavailableError(RuntimeError):
    pass


def directory_path(data_dir: Path) -> Path:
    return data_dir / "library-directory.sqlite3"


def place_id(city: str, state: str) -> str:
    return f"{re.sub(r'[^a-z0-9]+', '-', city.lower()).strip('-')}-{state.lower()}"


DIRECTIONS = {"N", "S", "E", "W", "NE", "NW", "SE", "SW"}


def display(value: str) -> str:
    """Readable casing for the survey's uppercase names: 'NE' stays, '4TH' becomes '4th'."""
    return re.sub(
        r"[A-Za-z0-9]+",
        lambda match: (
            match.group().upper()
            if match.group().upper() in DIRECTIONS
            else match.group().capitalize()
        ),
        " ".join(value.split()),
    )


def download(client: httpx.Client, url: str = PLS_URL) -> bytes:
    with client.stream("GET", url, follow_redirects=True) as response:
        response.raise_for_status()
        chunks, size = [], 0
        for chunk in response.iter_bytes():
            size += len(chunk)
            if size > MAX_DOWNLOAD_BYTES:
                raise DirectoryUnavailableError("Directory download exceeds 20 MiB")
            chunks.append(chunk)
    return b"".join(chunks)


def _rows(archive: zipfile.ZipFile, pattern: str) -> list[dict[str, str]]:
    names = [name for name in archive.namelist() if re.search(pattern, name, re.I)]
    if len(names) != 1:
        raise DirectoryUnavailableError(f"Expected one file matching {pattern} in the archive")
    text = archive.read(names[0]).decode("latin-1")
    return list(csv.DictReader(io.StringIO(text)))


def build(archive_bytes: bytes, target: Path) -> dict[str, int]:
    """Replace the local index from a PLS CSV archive; returns row counts."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
        systems = _rows(archive, r"_AE_.*\.csv$")
        outlets = _rows(archive, r"outlet.*\.csv$")
    except zipfile.BadZipFile as error:
        raise DirectoryUnavailableError("Directory download is not a ZIP archive") from error
    required = {"STABR", "FSCSKEY", "LIBNAME", "ADDRESS", "CITY"}
    if not systems or not outlets or not required <= set(systems[0]) | set(outlets[0]):
        raise DirectoryUnavailableError("Directory archive is missing expected columns")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_suffix(".building")
    staging.unlink(missing_ok=True)
    with closing(sqlite3.connect(staging)) as database, database:
        database.execute(
            "CREATE TABLE systems (fscskey TEXT PRIMARY KEY, name TEXT, address TEXT, "
            "city TEXT, state TEXT, latitude REAL, longitude REAL)"
        )
        database.execute(
            "CREATE TABLE outlets (fscskey TEXT, name TEXT, address TEXT, city TEXT, "
            "state TEXT, place_id TEXT)"
        )
        database.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        database.executemany(
            "INSERT OR REPLACE INTO systems VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    row["FSCSKEY"],
                    row["LIBNAME"].strip(),
                    row["ADDRESS"].strip(),
                    row["CITY"].strip(),
                    row["STABR"].strip(),
                    _number(row.get("LATITUDE")),
                    _number(row.get("LONGITUD")),
                )
                for row in systems
            ],
        )
        database.executemany(
            "INSERT INTO outlets VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    row["FSCSKEY"],
                    row["LIBNAME"].strip(),
                    row["ADDRESS"].strip(),
                    row["CITY"].strip(),
                    row["STABR"].strip(),
                    place_id(row["CITY"].strip(), row["STABR"].strip()),
                )
                for row in outlets
                if row.get("C_OUT_TY") in VENUE_TYPES and row["CITY"].strip()
            ],
        )
        database.execute("CREATE INDEX outlets_place ON outlets (place_id)")
        database.execute("INSERT INTO meta VALUES ('edition', ?)", (PLS_EDITION,))
        counts = {
            "systems": database.execute("SELECT COUNT(*) FROM systems").fetchone()[0],
            "outlets": database.execute("SELECT COUNT(*) FROM outlets").fetchone()[0],
            "places": database.execute("SELECT COUNT(DISTINCT place_id) FROM outlets").fetchone()[
                0
            ],
        }
    staging.replace(target)
    logger.info("Library directory built %s", counts)
    return counts


def _number(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def _open(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise DirectoryUnavailableError(
            "Library directory not set up. Run: uv run python scripts/dev.py setup-directory"
        )
    database = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    database.row_factory = sqlite3.Row
    return database


def search(path: Path, query: str, limit: int = SEARCH_LIMIT) -> list[dict]:
    """Find towns by name prefix, optionally narrowed with ', ST'. Exact names rank first."""
    city, _, state = (part.strip() for part in query.partition(","))
    if len(city) < 2:
        return []
    city_pattern = re.sub(r"[%_\\]", lambda match: "\\" + match.group(0), city.upper()) + "%"
    with closing(_open(path)) as database:
        rows = database.execute(
            """SELECT place_id, city, state, COUNT(*) AS branches,
                COUNT(DISTINCT fscskey) AS systems FROM outlets
                WHERE city LIKE ? ESCAPE '\\' AND (? = '' OR state = ?)
                GROUP BY place_id ORDER BY city != ?, branches DESC, city, state LIMIT ?""",
            (city_pattern, state.upper(), state.upper(), city.upper(), limit),
        ).fetchall()
    return [
        {
            "id": row["place_id"],
            "name": f"{display(row['city'])}, {row['state']}",
            "branch_count": row["branches"],
            "system_count": row["systems"],
        }
        for row in rows
    ]


def place(path: Path, identity: str) -> dict:
    """All library systems with a venue in the town, and only their in-town branches."""
    with closing(_open(path)) as database:
        outlets = database.execute(
            "SELECT * FROM outlets WHERE place_id = ? ORDER BY fscskey, name", (identity,)
        ).fetchall()
        if not outlets:
            raise LookupError(f"No library venues found for location: {identity}")
        edition = database.execute("SELECT value FROM meta WHERE key = 'edition'").fetchone()[0]
        systems = []
        for key in dict.fromkeys(row["fscskey"] for row in outlets):
            system = database.execute("SELECT * FROM systems WHERE fscskey = ?", (key,)).fetchone()
            if system is None:
                raise DirectoryUnavailableError(f"Directory is missing library system {key}")
            systems.append(
                {
                    "fscskey": key,
                    "name": display(system["name"]),
                    "latitude": system["latitude"],
                    "longitude": system["longitude"],
                    "branches": [
                        {"name": display(row["name"]), "address": display(row["address"])}
                        for row in outlets
                        if row["fscskey"] == key
                    ],
                }
            )
    return {
        "id": identity,
        "name": f"{display(outlets[0]['city'])}, {outlets[0]['state']}",
        "directory_edition": f"IMLS PLS {edition}",
        "systems": systems,
    }
