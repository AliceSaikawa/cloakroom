#!/usr/bin/env python3
# Usage: echo "テキスト" | python detect.py
# Output: JSON array of {text, start, end, category}
import sys, json
import spacy  # ginza

nlp = spacy.load("ja_ginza")
text = sys.stdin.read().strip()
doc = nlp(text)

results = []
for ent in doc.ents:
    category = None
    if ent.label_ in ("Person", "PERSON"):
        category = "NAME"
    elif ent.label_ in ("Corporation", "ORG", "Organization"):
        category = "ORG"
    elif ent.label_ in ("School", "SCHOOL"):
        category = "SCHOOL"
    if category:
        results.append({"text": ent.text, "start": ent.start_char, "end": ent.end_char, "category": category})

print(json.dumps(results, ensure_ascii=False))
