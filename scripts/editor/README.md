# Local Runner

The application editor runs on localhost. The Windows launcher chooses a free port from 8053 through 8073, reusing this checkout's server if one is already running. It opens the browser at the selected URL. The optional source editor is at /code on that same port. It loads Monaco, PDF.js, Split.js, icons and fonts from public CDNs, so /code needs an internet connection on first use.

On Windows, run python scripts/bootstrap.py, then create and use the local shortcut:

    pwsh -File scripts/editor/create-shortcut.ps1

    pwsh -File scripts/editor/start-background.ps1

On macOS or Linux, run python3 scripts/bootstrap.py and then:

    sh start.sh

On macOS or Linux, open http://127.0.0.1:8053/ in a browser. If port 8053 is occupied, pass another port to `start.sh`, for example `sh start.sh 8054`. On Windows, `pwsh -File scripts/editor/start-background.ps1 -NoBrowser` prints the selected URL, and `-Port 8054` requests a specific port. The server can also be started directly with the .venv Python and scripts/editor/server.py.

For a code change, run the Python tests, the Node tests, scripts/doctor.py --build and a real browser check. Build and output files are generated locally.
