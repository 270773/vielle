import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_env_file(ROOT / "config.env")


def _path(name: str, default: str) -> Path:
    p = Path(os.environ.get(name, default))
    return p if p.is_absolute() else ROOT / p


DB_PATH = _path("LABELQC_DB_PATH", "data/labelqc.db")
PDF_ROOT = _path("LABELQC_PDF_ROOT", "data/modeles")
ARCHIVE_PATH = _path("LABELQC_ARCHIVE_PATH", "data/archives")
OCR_LANGS = os.environ.get("LABELQC_OCR_LANGS", "tur+fra+eng")
LIBRETRANSLATE_URL = os.environ.get("LABELQC_LIBRETRANSLATE_URL", "").strip()
RENDER_DPI = int(os.environ.get("LABELQC_RENDER_DPI", "300"))
WORK_SIZE = int(os.environ.get("LABELQC_WORK_SIZE", "2000"))
