"""Build demo/trip-replay.html from the simulator output: python3 demo/build.py trip.json out.html"""
import json, sys, pathlib

trip, out = sys.argv[1], sys.argv[2]
d = json.load(open(trip))
d["track"] = [[round(a, 6), round(b, 6)] for a, b in d["track"]]
template = (pathlib.Path(__file__).parent / "template.html").read_text()
pathlib.Path(out).write_text(template.replace("/*DATA*/null", json.dumps(d, separators=(",", ":"))))
