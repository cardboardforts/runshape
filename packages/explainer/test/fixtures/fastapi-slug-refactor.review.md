## Behaviour changes (Runshape)

4 tests ran on both the base and this branch.

**2 tests still pass but now run differently** — the changes a green CI won't show you.

### Still passing, but now run differently (2)

| Test | What changed |
|---|---|
| `test_user_can_not_create_article_with_duplicated_slug` | now calls `ensure_slug_available`, `_normalize_title`; 17 calls moved under a new caller; different lines run in `create_new_article`, `get_slug_for_article` |
| `test_user_can_create_article` | now calls `ensure_slug_available`, `_normalize_title`; 4 calls moved under a new caller; different lines run in `create_new_article`, `get_slug_for_article` |

2 tests behave exactly as before.

Compared `main` (`0123456` the main commit) with the working tree (on `0123456`).

### Architecture

No architecture changes.

### Routes

- `POST /api/articles`: 2 ways changed
  - now calls `ensure_slug_available`, `_normalize_title` (2 ways)
