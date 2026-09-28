# Local Runner

The application editor is at http://127.0.0.1:8053/. The optional source editor is at /code. The server binds to localhost. The source editor loads Monaco, PDF.js, Split.js, icons and fonts from public CDNs, so /code needs an internet connection on first use.

On Windows, run python scripts/bootstrap.py, then create and use the local shortcut:

    pwsh -File scripts/editor/create-shortcut.ps1

    pwsh -File scripts/editor/start-background.ps1

On macOS or Linux, run python3 scripts/bootstrap.py and then:

    sh start.sh

Open http://127.0.0.1:8053/ in a browser. The server can also be started directly with the .venv Python and scripts/editor/server.py.

For a code change, run the Python tests, the Node tests, scripts/doctor.py --build and a real browser check. Build and output files are generated locally.
