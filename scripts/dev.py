"""Cross-platform commands. Run from the repository root with uv run python scripts/dev.py."""

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import TextIO

ROOT = Path(__file__).resolve().parents[1]
WEBSITE = ROOT / "projects" / "website"
LOCAL = ROOT / ".local"
LOCK = LOCAL / "stack.lock"
STOP = LOCAL / "stop.request"
ENV = {**os.environ, "ASTRO_TELEMETRY_DISABLED": "1"}


def executable(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Missing prerequisite: {name}. See README setup instructions.")
    return path


def command(args: list[str], cwd: Path = ROOT) -> None:
    subprocess.run(args, cwd=cwd, env=ENV, check=True)


def check_node() -> None:
    version = subprocess.check_output([executable("node"), "--version"], text=True).strip()
    if version.split(".")[0] != "v24":
        raise RuntimeError(f"Node.js 24 LTS required; found {version}")


def setup(browser: bool) -> None:
    check_node()
    executable("mailpit")
    command([executable("uv"), "sync", "--locked"])
    command([executable("npm"), "ci"], WEBSITE)
    if browser:
        command([sys.executable, "-m", "playwright", "install", "chromium"])
    print("Setup complete. Start with: uv run python scripts/dev.py up")
    print("Ollama must be installed/started separately. No model is downloaded by setup.")


def assert_ports_free() -> None:
    for port in (8000, 4321, 1025, 8025):
        with socket.socket() as listener:
            if os.name == "nt":
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            listener.bind(("127.0.0.1", port))


def responding(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def up() -> None:
    check_node()
    mailpit = executable("mailpit")
    astro_package = WEBSITE / "node_modules" / "astro"
    manifest = astro_package / "package.json"
    if not manifest.is_file():
        raise RuntimeError("Website dependencies missing. Run setup first.")
    cli = json.loads(manifest.read_text(encoding="utf-8"))["bin"]
    astro = astro_package / (cli if isinstance(cli, str) else cli["astro"])
    if not astro.is_file():
        raise RuntimeError("Astro CLI missing. Run setup to restore website dependencies.")
    LOCAL.mkdir(exist_ok=True)
    try:
        lock_file = LOCK.open("x")
    except FileExistsError as error:
        raise RuntimeError(
            "Stack lock exists. Use the stop command. If a previous launcher crashed, "
            "confirm its processes have exited before removing .local/stack.lock."
        ) from error
    children: list[tuple[str, subprocess.Popen, TextIO]] = []
    try:
        with lock_file:
            lock_file.write(str(os.getpid()))
        STOP.unlink(missing_ok=True)
        assert_ports_free()
        logs = LOCAL / "logs"
        logs.mkdir(exist_ok=True)
        specifications = [
            ("mailpit", [mailpit, "--listen", "127.0.0.1:8025", "--smtp", "127.0.0.1:1025"], ROOT),
            (
                "api",
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "projects.backend.api.app:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "8000",
                ],
                ROOT,
            ),
            (
                "worker",
                [sys.executable, "-m", "projects.backend.modules.orchestration.worker"],
                ROOT,
            ),
            (
                "website",
                [executable("node"), str(astro), "dev", "--host", "127.0.0.1", "--port", "4321"],
                WEBSITE,
            ),
        ]
        for name, args, cwd in specifications:
            output = (logs / f"{name}.log").open("a", encoding="utf-8")
            try:
                child = subprocess.Popen(
                    args,
                    cwd=cwd,
                    env=ENV,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                )
            except OSError:
                output.close()
                raise
            children.append((name, child, output))
        deadline = time.monotonic() + 60
        while True:
            for name, child, _ in children:
                if child.poll() is not None:
                    raise RuntimeError(
                        f"{name} exited ({child.returncode}); inspect .local/logs/{name}.log"
                    )
            if STOP.exists():
                return
            if all(
                responding(url)
                for url in (
                    "http://127.0.0.1:8000/api/live",
                    "http://127.0.0.1:4321",
                    "http://127.0.0.1:8025/livez",
                )
            ):
                break
            if time.monotonic() > deadline:
                raise RuntimeError("Stack startup timed out; inspect .local/logs.")
            time.sleep(0.5)
        print("Website: http://127.0.0.1:4321", flush=True)
        print("Health:  http://127.0.0.1:8000/review", flush=True)
        print("Mailpit: http://127.0.0.1:8025", flush=True)
        print("Services started, not necessarily healthy. Check the health page.", flush=True)
        print("Ctrl+C or the stop command shuts down only this launcher's children.", flush=True)
        while not STOP.exists():
            for name, child, _ in children:
                if child.poll() is not None:
                    raise RuntimeError(f"{name} exited; inspect .local/logs/{name}.log")
            time.sleep(0.5)
    finally:
        for _, child, _ in reversed(children):
            if child.poll() is None:
                child.terminate()
        for _, child, output in reversed(children):
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            output.close()
        STOP.unlink(missing_ok=True)
        LOCK.unlink(missing_ok=True)


def stop() -> None:
    if not LOCK.exists():
        raise RuntimeError("No launcher lock found; no processes were stopped.")
    STOP.touch()
    deadline = time.monotonic() + 30
    while LOCK.exists():
        if time.monotonic() > deadline:
            raise RuntimeError("Launcher did not acknowledge stop; inspect its terminal and logs.")
        time.sleep(0.25)
    print("Local stack stopped.")


def contracts() -> None:
    sys.path.insert(0, str(ROOT))
    from shared.contracts.health import EditionsResponse, HealthReport

    for name, model in (("health", HealthReport), ("editions", EditionsResponse)):
        target = ROOT / "shared" / "contracts" / f"{name}.schema.json"
        target.write_text(json.dumps(model.model_json_schema(), indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Newsbee native local development")
    parser.add_argument(
        "action",
        choices=[
            "setup",
            "up",
            "stop",
            "test",
            "browser",
            "contracts",
            "ingest-events",
            "events",
            "evaluate-model",
            "draft-edition",
        ],
    )
    parser.add_argument("--browser", action="store_true", help="Install Chromium during setup")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 13):
        raise RuntimeError("Use Python 3.13 via uv.")
    if args.action == "setup":
        setup(args.browser)
    elif args.action == "up":
        up()
    elif args.action == "stop":
        stop()
    elif args.action == "test":
        command([sys.executable, "-m", "pytest"])
    elif args.action == "browser":
        command([sys.executable, "-m", "pytest", "-m", "browser"])
    elif args.action == "contracts":
        contracts()
    elif args.action == "evaluate-model":
        import asyncio

        sys.path.insert(0, str(ROOT))
        from projects.backend.shared.configuration.settings import Settings
        from projects.backend.shared.model_inference.evaluation import evaluate
        from projects.backend.shared.observability.logging import configure_logging

        configure_logging()
        path, passed = asyncio.run(evaluate(Settings()))
        print(f"Evaluation saved: {path}")
        print("Human review of every headline and blurb is required; automatic checks do not prove factuality.")
        if not passed:
            raise RuntimeError("Model evaluation checks failed; inspect the saved report")
    elif args.action == "draft-edition":
        import asyncio

        sys.path.insert(0, str(ROOT))
        from projects.backend.modules.editions.drafting import draft_edition
        from projects.backend.shared.configuration.settings import Settings
        from projects.backend.shared.observability.logging import configure_logging
        from projects.backend.shared.storage.database import initialize

        configure_logging()
        settings = Settings()
        initialize(settings.database)
        run = asyncio.run(draft_edition(settings))
        print(
            f"Draft edition {run.window_start} to {run.window_end}: {run.status}; "
            f"included {run.included}, held {run.held}, skipped over limit "
            f"{run.skipped_over_limit}."
        )
        print("Inspect: http://127.0.0.1:8000/review/editions (human review required)")
    else:
        sys.path.insert(0, str(ROOT))
        from projects.backend.modules.orchestration import jobs
        from projects.backend.modules.source_connectors.pipelines.events import load_source
        from projects.backend.shared.configuration.settings import Settings
        from projects.backend.shared.observability.logging import configure_logging
        from projects.backend.shared.storage.database import initialize

        configure_logging()
        settings = Settings()
        initialize(settings.database)
        if args.action == "ingest-events":
            source = load_source("spl-capitol-hill")
            identity = jobs.enqueue(settings.database, source.id)
            print(f"Ingestion queued: {identity}. Start the local worker with the up command.")
        else:
            print(json.dumps(jobs.inspect(settings.database), indent=2))


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        main()
    except KeyboardInterrupt:
        print("\nLocal command interrupted.")
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
