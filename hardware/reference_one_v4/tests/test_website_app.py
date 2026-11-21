"""The measurement app's V4 wiring (website/app). The app is found through git's common dir, so
these also run from a worktree, and they skip where it is absent. They check that the app's
copy of the V4 core is this one,
byte for byte, and run the app's V4 tests in Node: the V4 tab's logic on the digital twin."""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def _app():
    r = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                       cwd=HERE, capture_output=True, text=True, check=False)
    return Path(r.stdout.strip()).parent / "website" / "app" if r.returncode == 0 else None


APP = _app()
pytestmark = pytest.mark.skipif(APP is None or not (APP / "index.html").exists(),
                                reason="website/app is not in the main checkout")


def test_the_app_carries_this_v4_core_byte_for_byte():
    copy = APP / "js" / "v4" / "v4core.mjs"
    assert copy.read_bytes() == (HERE / "app" / "v4core.mjs").read_bytes(), (
        f"{copy} differs from app/v4core.mjs: copy it across")


def _node_test(name):
    env = {**os.environ, "V4_APP_DIR": str(APP)}
    r = subprocess.run([NODE, "--test", str(HERE / "tests" / name)],
                       capture_output=True, text=True, timeout=900, env=env, check=False)
    assert r.returncode == 0, (r.stdout + r.stderr)[-4000:]


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_the_apps_v4_tab_logic_on_the_twin():
    _node_test("website_v4_session.test.mjs")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_the_apps_audio_engine_caps_a_v4_and_drives_one_side():
    _node_test("website_engine.test.mjs")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_the_v4_tab_sweeps_nothing_until_the_user_says_no_earphone_is_in_an_ear():
    _node_test("website_v4_panel.test.mjs")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_smoothing_and_the_connect_shortlist():
    _node_test("website_graph.test.mjs")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_the_studio_curves_follow_the_graph_tabs_rules():
    _node_test("website_studio_curves.test.mjs")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_the_studio_reads_and_writes_curve_files():
    _node_test("website_studio_parse.test.mjs")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_the_studio_keeps_one_entry_per_earphone():
    _node_test("website_studio_store.test.mjs")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_the_studio_eq_filters_and_files():
    _node_test("website_studio_peq.test.mjs")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_the_studio_targets_and_graph_arithmetic():
    _node_test("website_studio_targets_graph.test.mjs")
