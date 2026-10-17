"""Check the shipped Python/browser pair without using system browsers or network."""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from src.generic.acquisition import bundled_browser_options

with sync_playwright() as playwright:
    for engine in ("chromium", "firefox"):
        browser = getattr(playwright, engine).launch(headless=True, **bundled_browser_options(playwright, engine))
        try:
            page = browser.new_page()
            page.set_content("<h1>T3 bundled browser</h1>")
            assert page.locator("h1").inner_text() == "T3 bundled browser"
            print(f"PASS: shipped Python launched its matching bundled browser ({engine}) and read a local page")
        finally:
            browser.close()
