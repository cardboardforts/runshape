# Example apps

Two RealWorld ("Conduit") backends used to develop and test Runshape against real code. Neither is
committed here: `setup.sh` clones each at a pinned commit and applies what's in `patches/`.

```sh
./setup.sh                 # clone, patch, build a venv for each (needs uv)
./postgres.sh start        # FastAPI only: local Postgres 16 on 127.0.0.1:54329, no Docker
./record.sh django         # run the app's tests with --runshape
./record.sh fastapi
./postgres.sh stop
```

Recordings land in `<app>/.runshape/traces/`. Open `examples/<app>` in VS Code and run
**Runshape: Open Runtime View**.

## fastapi-realworld-example-app — unchanged

[nsidnev/fastapi-realworld-example-app](https://github.com/nsidnev/fastapi-realworld-example-app)
@ `029eb77`, MIT. Runs on Python 3.9 from its own `poetry.lock`, so it exercises the recorder's
`settrace` backend. Two environment details, no code changes:

- `setuptools==65.5.0` is added to the venv: uv venvs don't ship it, and this version of `aiosql`
  imports `pkg_resources`. Pinned to a 2022 release because the suite runs with
  `filterwarnings = error` and newer setuptools warns on that import.
- Recording uses `-n0 --no-cov`: the settrace backend can't share the tracer with coverage, and
  recording across xdist workers isn't supported yet. The recorder refuses to start otherwise
  and says why.

## django-realworld-example-app — ported, with tests added

[gothinkster/django-realworld-example-app](https://github.com/gothinkster/django-realworld-example-app)
@ `29c9d42` (2017) pins Django 1.10, which needs Python ≤ 3.6. Rather than support a 2016
interpreter in the recorder, `patches/django-realworld.patch` ports it to Django 5.2 / Python 3.12
(which exercises the `sys.monitoring` backend). Every change:

| change | why |
|---|---|
| `url()` → `re_path()`, `include((module, app_name), namespace=...)` | `django.conf.urls.url` removed in Django 4.0 |
| `is_authenticated()` → `is_authenticated` | became a property in Django 2.0 |
| `jwt.encode(...)` result no longer `.decode()`d; `jwt.decode(..., algorithms=["HS256"])` | PyJWT 2 returns `str` and requires `algorithms` |
| `CORS_ORIGIN_WHITELIST` → `CORS_ALLOWED_ORIGINS` with schemes; `django-cors-middleware` → `django-cors-headers` | the original package is abandoned |
| `INSTALLED_APPS` names the `AppConfig` classes | Django 4.1 dropped `default_app_config`, which is what connected the signals that create a user's profile |
| removed `django_extensions` and `USE_L10N`; set `DEFAULT_AUTO_FIELD = AutoField` | dev-only app; setting removed in 5.0; matches the original migrations (`makemigrations --check` is clean) |
| added `pytest.ini` and `tests/test_user_journeys.py` | upstream has no tests; each test is one user journey and so one scenario |

**Upstream bug found while writing the tests:** `GET /api/articles/feed` returns 404. The DRF
router's `articles/<slug>` route is registered before `articles/feed`, so "feed" is looked up
as an article slug. Left unfixed on purpose and recorded as a strict `xfail`, since "the router
sent this request to the wrong handler" is exactly what the viewer should make visible.

The upstream repo has no license file, so its source is not copied into this repo's test
fixtures (only traces, which hold names, line numbers and SQL).
