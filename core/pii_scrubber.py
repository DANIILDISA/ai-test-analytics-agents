from __future__ import annotations
import re

# Order matters: email first (avoids phone-regex false-triggering on digits inside
# an email local-part), then phone, then the FIO heuristic last (so an already-masked
# "[EMAIL]"/"[ТЕЛЕФОН]" placeholder can never itself look like a name).
# ASCII-only domain (won't catch Cyrillic/IDN domains like имя@почта.рф) — low real-world
# incidence since major Russian providers use Latin domains.
_EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+")
# Prefix (+7/8/7) is optional so bare mobile numbers (e.g. "9161234567") are still caught;
# requiring the first digit to be 9 (all RU mobile operator codes start with 9) keeps this
# from degenerating into an overly broad "any 10 digits" matcher.
_PHONE_RE = re.compile(r"(?:(?:\+7|8|7)[\s\-]?)?\(?9\d{2}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}")
# Best-effort: 2-3 consecutive Title-Case Cyrillic words (e.g. "Иванов Иван Иванович").
# Not a real NLP name detector — documented limitation, see design spec.
# Known false positives (accepted tradeoff): ordinary two-capitalized-word phrases like
# "Санкт Петербург" or "Старший Менеджер" also get masked. We accept this to avoid
# missing genuine names, which matters more for privacy than occasional over-masking.
# Names that are COURSE CONTENT («Фредерик Тейлор» in a question/option) are exempted via
# ``ContentAllowlist`` (below), never by loosening this pattern.
_FIO_RE = re.compile(r"\b[А-ЯЁ][а-яё]+(?:[\s\-][А-ЯЁ][а-яё]+){1,2}\b")

_PATTERNS = (
    ("EMAIL", _EMAIL_RE),
    ("ТЕЛЕФОН", _PHONE_RE),
    ("ФИО", _FIO_RE),
)

_CAP_WORD_RE = re.compile(r"[А-ЯЁ][а-яё]+")
_ANY_WORD_RE = re.compile(r"[^\W\d_]+")

# Russian case endings (longest first) — used only to compare name forms («Тейлор» ~ «Тейлора»).
_ENDINGS = tuple(sorted((
    "ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ов", "ев", "ей", "ом", "ем",
    "ою", "ею", "ой", "ую", "юю", "ам", "ям", "ым", "им", "ах", "ях", "ых", "их", "ая", "яя",
    "ые", "ие", "а", "я", "у", "ю", "ы", "и", "е", "о",
), key=len, reverse=True))


def _stem(word: str) -> str:
    w = word.casefold().replace("ё", "е")
    for e in _ENDINGS:
        if w.endswith(e) and len(w) - len(e) >= 3:
            return w[: -len(e)]
    return w


# Sentence-initial words that look like a "name" only because of capitalisation.
_FUNC_STEMS = frozenset(_stem(w) for w in (
    "что кто как где когда какой какая какие какое каков почему зачем сколько чей это этот эта "
    "эти расскажи объясни покажи сравни найди дай есть был была были при для про или и но а"
).split())


class ContentAllowlist:
    """Name-like phrases that are COURSE CONTENT (question texts, answer options, the etalon,
    reference data) — historical figures such as «Фредерик Тейлор» are not people to protect.

    A FIO-like match is kept when its words (compared by stem, so any case form works) form a
    phrase seen in the course material. Student identities are masked BEFORE this is consulted."""

    def __init__(self) -> None:
        self._phrases: set[tuple[str, ...]] = set()
        self._vocab: set[str] = set()
        self._seen: set[str] = set()

    def __bool__(self) -> bool:
        return bool(self._phrases)

    def __len__(self) -> int:
        return len(self._phrases)

    def add_text(self, text) -> None:
        if not isinstance(text, str) or not text or text in self._seen:
            return
        self._seen.add(text)
        self._vocab.update(_stem(w) for w in _ANY_WORD_RE.findall(text))
        for m in _FIO_RE.finditer(text):
            stems = [_stem(w) for w in _CAP_WORD_RE.findall(m.group(0))]
            for i in range(len(stems)):
                for j in range(i + 2, len(stems) + 1):
                    self._phrases.add(tuple(stems[i:j]))

    def add_texts(self, texts) -> None:
        for t in texts:
            self.add_text(t)

    def knows_word(self, stem: str) -> bool:
        return stem in self._vocab or stem in _FUNC_STEMS

    def mask_fio(self, match_text: str) -> tuple[str, int]:
        """Apply the allowlist to one FIO-like match: return (text, number_of_[ФИО]_inserted)."""
        words = list(_CAP_WORD_RE.finditer(match_text))
        stems = [_stem(w.group(0)) for w in words]
        n = len(words)
        keep = [False] * n
        i = 0
        while i < n:
            for j in range(n, i + 1, -1):  # longest allowed run first (>= 2 words)
                if tuple(stems[i:j]) in self._phrases:
                    keep[i:j] = [True] * (j - i)
                    i = j - 1
                    break
            i += 1
        if not any(keep):
            return "[ФИО]", 1
        # Leftover capitalised words next to an allowed phrase stay only if they are ordinary
        # course vocabulary / question words («Что Фредерик Тейлор…»); anything else is masked.
        masked = [not k and not self.knows_word(st) for k, st in zip(keep, stems)]
        if not any(masked):
            return match_text, 0
        out, pos, count, k = [], 0, 0, 0
        while k < n:
            if not masked[k]:
                k += 1
                continue
            e = k
            while e + 1 < n and masked[e + 1]:
                e += 1
            out.append(match_text[pos:words[k].start()] + "[ФИО]")
            pos = words[e].end()
            count += 1
            k = e + 1
        out.append(match_text[pos:])
        return "".join(out), count


def scrub(text: str, allow: ContentAllowlist | None = None) -> tuple[str, list[str]]:
    """Mask email/phone/FIO-like patterns in text; return (masked_text, found_labels).
    found may contain duplicate labels if a category matches more than once.
    ``allow`` (course-content names) exempts FIO-like phrases that are part of the course."""
    if not text:
        return text, []
    found: list[str] = []
    result = text
    for label, pattern in _PATTERNS:
        if label == "EMAIL" and "@" not in result:
            continue
        if label == "ФИО" and allow:
            def _replace(m):
                out, cnt = allow.mask_fio(m.group(0))
                found.extend(["ФИО"] * cnt)
                return out
        else:
            def _replace(m, label=label):
                found.append(label)
                return f"[{label}]"
        result = pattern.sub(_replace, result)
    return result, found


# --- korpus-c2 additions: student identifiers -------------------------------------------
# Numeric LMS ids (8+ digits, e.g. 20251022001) and UUIDs. Lookarounds exclude run ids such
# as 20251022-153000-ab12cd (digits glued to a hyphen / word char).
_UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_NUM_ID_RE = re.compile(r"(?<![\w-])\d{8,}(?![\w-])")


class Pseudonymizer:
    """Stable per-instance mapping of student identifiers to «Слушатель N» (kept locally)."""

    def __init__(self, allow: ContentAllowlist | None = None, identities=()) -> None:
        self.forward: dict[str, str] = {}
        self.reverse: dict[str, str] = {}
        self.allow = allow if allow is not None else ContentAllowlist()
        self._identities: dict[str, re.Pattern] = {}
        self.add_identities(identities)

    def add_identities(self, items) -> None:
        """Register student identifiers (the «Пользователь» column: names, logins, emails) to be
        masked everywhere — even when they look like course content. Numeric ids are covered by
        the 8+ digit rule; very short / digit-only values are skipped (would mask ordinary text)."""
        for raw in items:
            s = " ".join(str(raw or "").split())
            if len(s) < 4 or not any(c.isalpha() for c in s) or s in self._identities:
                continue
            self._identities[s] = re.compile(r"(?<!\w)" + re.escape(s) + r"(?!\w)", re.IGNORECASE)

    def learn(self, texts=(), identities=()) -> None:
        """Register course content (kept unmasked) and student identities (always masked)."""
        self.allow.add_texts(texts)
        self.add_identities(identities)

    def _pseudo(self, real: str) -> str:
        p = self.forward.get(real)
        if p is None:
            p = f"Слушатель {len(self.forward) + 1}"
            self.forward[real] = p
            self.reverse[p] = real
        return p

    def mask_ids(self, text: str) -> str:
        if not text:
            return text
        text = _UUID_RE.sub(lambda m: self._pseudo(m.group(0)), text)
        text = _NUM_ID_RE.sub(lambda m: self._pseudo(m.group(0)), text)
        for ident in sorted(self._identities, key=len, reverse=True):  # longest first
            text = self._identities[ident].sub(lambda m, i=ident: self._pseudo(i), text)
        return text

    def restore(self, text: str) -> str:
        if not text or not self.reverse:
            return text
        for p in sorted(self.reverse, key=len, reverse=True):  # «Слушатель 12» before «Слушатель 1»
            text = text.replace(p, self.reverse[p])
        return text

    def mask(self, text: str) -> str:
        """ids -> pseudonyms, then email/phone/FIO scrub (pseudonym has a digit, so FIO skips it).
        FIO-like phrases that are course content (``self.allow``) are kept."""
        return scrub(self.mask_ids(text), self.allow)[0]

    def mask_obj(self, obj):
        if isinstance(obj, str):
            return self.mask(obj)
        if isinstance(obj, list):
            return [self.mask_obj(x) for x in obj]
        if isinstance(obj, dict):
            return {k: self.mask_obj(v) for k, v in obj.items()}
        return obj

    def restore_obj(self, obj):
        if isinstance(obj, str):
            return self.restore(obj)
        if isinstance(obj, list):
            return [self.restore_obj(x) for x in obj]
        if isinstance(obj, dict):
            return {k: self.restore_obj(v) for k, v in obj.items()}
        return obj


# --- course-content harvesting ---------------------------------------------------------
_FREE_TEXT_TYPES = ("текстовый ввод", "числовой ввод", "неизвестно")


def content_from_course(course) -> tuple[list[str], list[str]]:
    """(course-content texts, student identifiers) of a parsed ``CourseData``.

    Content = question texts, the LMS etalon (``correct_answer``), reference data, and the given
    answers of CHOICE-type questions (those are the answer options). Free-text answers typed by
    students are NOT content — a name inside them is a person and stays masked."""
    texts: set[str] = set()
    ids: set[str] = set()
    for att in getattr(course, "attempts", None) or []:
        ids.add(str(att.student_id))
        for a in att.answers:
            texts.add(a.question_text)
            texts.add(a.correct_answer)
            if a.question_type.value not in _FREE_TEXT_TYPES:
                texts.add(a.given_answer)
    for per_test in (getattr(course, "reference", None) or {}).values():
        for ref in per_test.values():
            texts.update((ref.question_text, ref.raw_answer, *ref.acceptable))
    return [t for t in texts if t], [i for i in ids if i]


def content_from_run(run: dict) -> tuple[list[str], list[str]]:
    """Same, from a stored analysis result (``report.json`` dict)."""
    texts: set = set()
    ids: set[str] = set()

    def questions(answer):
        for q in (answer or {}).get("questions") or []:
            texts.add(q.get("question_text"))
            texts.add(q.get("correct_answer"))
            if str(q.get("type") or "") not in _FREE_TEXT_TYPES:  # choice: wrong answers are options
                texts.update(e.get("answer") for e in q.get("common_errors") or [])
                texts.add((q.get("key_suspect") or {}).get("answer"))

    run = run or {}
    questions(run.get("answer"))
    for g in run.get("groups") or []:
        questions((g or {}).get("answer"))
    for s in (run.get("time") or {}).get("students") or []:
        ids.add(str(s.get("student_id") or ""))
    return [t for t in texts if isinstance(t, str) and t], [i for i in ids if i]
