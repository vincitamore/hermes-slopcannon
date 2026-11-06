"""The dashboard api keeps the path Hermes gave it (offline; no Hermes required).

Hermes lends a plugin the user's sign-in only from code whose file lies under a plugins folder. A
plugin installed as a link to a checkout that loads itself from the resolved target is refused, which
broke every button on the film card that needs the sign-in.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def _link(target: Path, link: Path) -> bool:
    try:
        if os.name == "nt":
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
        else:
            os.symlink(target, link, target_is_directory=True)
        return True
    except OSError:
        return False


@unittest.skipUnless(importlib.util.find_spec("fastapi"), "fastapi not installed")
class DashboardApiKeepsTheLinkPath(unittest.TestCase):
    def test_package_loads_from_the_link_not_its_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            link = Path(tmp) / "plugins" / "slopcannon"
            link.parent.mkdir()
            if not _link(ROOT, link):
                self.skipTest("cannot make a directory link here")
            try:
                name = "test_slopcannon_dashboard_api"
                spec = importlib.util.spec_from_file_location(name, link / "dashboard" / "plugin_api.py")
                assert spec is not None and spec.loader is not None
                module = importlib.util.module_from_spec(spec)
                sys.modules[name] = module
                spec.loader.exec_module(module)
                self.assertEqual(module._PACKAGE_DIR, link.absolute())

                seen = {}

                def refuse(alias, init, **kwargs):
                    seen["init"] = Path(init)
                    seen["search"] = kwargs.get("submodule_search_locations")
                    return None

                saved = {k: v for k, v in sys.modules.items()}
                try:
                    # Hide any copy already imported so the fallback path is the one exercised.
                    for key in [k for k, v in sys.modules.items()
                                if getattr(v, "__file__", None)
                                and Path(v.__file__).resolve() == (ROOT / "__init__.py").resolve()]:
                        del sys.modules[key]
                    sys.modules.pop(module._ALIAS, None)
                    with mock.patch.object(module.importlib.util, "spec_from_file_location", refuse):
                        with self.assertRaises(RuntimeError):
                            module._package()
                finally:
                    sys.modules.clear()
                    sys.modules.update(saved)
                self.assertEqual(seen["init"], link.absolute() / "__init__.py")
                self.assertEqual(seen["search"], [str(link.absolute())])
            finally:
                sys.modules.pop("test_slopcannon_dashboard_api", None)
                os.rmdir(link) if os.name == "nt" else os.unlink(link)


if __name__ == "__main__":
    unittest.main()
