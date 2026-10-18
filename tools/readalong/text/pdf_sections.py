"""Rebuild chapters and paragraphs from a pdftotext -layout dump (no page markers
besides form feeds). Headings are matched at LINE level: a centred bare number
equal to the next expected chapter, or a centred EPILOGUE, after the contents."""
import re
WM = 'OceanofPDF.com'
END = tuple('.!?…”"’\')]>:;—')
CENTRED = 20      # headings are centred; body lines are flush left

def pages_of(path):
    raw = open(path, encoding='utf-8', errors='replace').read().split('\f')
    return raw[:-1] if raw and not raw[-1].strip() else raw

def parse(pages, first_body_page):
    """-> (sections, stats). A section is {'title','num','page','paragraphs':[{'text','page'}]}"""
    secs, cur, nxt, joins = [], None, 1, 0
    def new(title, num, page):
        nonlocal cur
        cur = {'title': title, 'num': num, 'page': page, 'paragraphs': []}; secs.append(cur)
    for n, pg in enumerate(pages, 1):
        if n < first_body_page: continue
        buf, first = [], True
        def flush():
            nonlocal buf, first, joins
            if not buf: return
            text = re.sub(r'\s+', ' ', ' '.join(buf)).strip(); buf = []
            if not text or cur is None: return
            paras = cur['paragraphs']
            # a paragraph cut by a page break is rejoined only on strong evidence
            if first and paras and paras[-1]['page'] == n - 1 and \
               not paras[-1]['text'].endswith(END) and text[:1].islower():
                paras[-1]['text'] += ' ' + text; joins += 1
            else:
                paras.append({'text': text, 'page': n})
            first = False
        for line in pg.replace(WM, '').split('\n'):
            s = line.strip(); ind = len(line) - len(line.lstrip())
            if not s: flush(); continue
            if ind >= CENTRED and re.fullmatch(r'\d{1,3}', s) and int(s) == nxt:
                flush(); new(f'Chapter {nxt}', nxt, n); nxt += 1; continue
            if ind >= CENTRED and s.upper() == 'EPILOGUE':
                flush(); new('Epilogue', None, n); continue
            buf.append(s)
        flush()
    return secs, {'joins': joins, 'lastNumbered': nxt - 1}
