#!/usr/bin/env python3
"""Stage 1 for an EPUB-only book: narrative text -> chapters.json + chapter-NN.txt.

No page numbers: these books have no PDF and no EPUB page markers, and the
reader shows "Page N" as fact, so none is emitted rather than invented.
"""
import hashlib, json, os, re, subprocess, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree as E
from html.parser import HTMLParser

class Para(HTMLParser):
    def __init__(self):
        super().__init__(); self.paras=[]; self.buf=None; self.head=None; self.hbuf=None; self.skip=0
    def handle_starttag(self,tag,attrs):
        if tag in ('p','li') and not self.skip: self.buf=[]
        if tag in ('h1','h2','h3') and self.head is None: self.hbuf=[]
    def handle_endtag(self,tag):
        if tag in ('p','li') and self.buf is not None:
            t=re.sub(r'\s+',' ',''.join(self.buf)).strip()
            if t: self.paras.append(t)
            self.buf=None
        if tag in ('h1','h2','h3') and self.hbuf is not None:
            self.head=re.sub(r'\s+',' ',''.join(self.hbuf)).strip(); self.hbuf=None
    def handle_data(self,d):
        if self.buf is not None: self.buf.append(d)
        if self.hbuf is not None: self.hbuf.append(d)

def spine(z):
    c=E.fromstring(z.read('META-INF/container.xml'))
    opf_path=c.find('.//{*}rootfile').attrib['full-path']
    opf=E.fromstring(z.read(opf_path))
    base=opf_path.rsplit('/',1)[0]+'/' if '/' in opf_path else ''
    man={i.attrib['id']:i.attrib['href'] for i in opf.findall('.//{*}manifest/{*}item')}
    return [base+man[it.attrib['idref']] for it in opf.findall('.//{*}spine/{*}itemref') if it.attrib['idref'] in man]

# Front/back matter that is printed but not part of the narration we align.
SKIP = re.compile(r'^(contents|copyright|dedication|title page|also by|about the author|'
                  r'mailing list|the page where we tout|one more|another one|acknowledg)', re.I)

def narrative(epub, min_words):
    z=zipfile.ZipFile(epub); out=[]
    for name in spine(z):
        try: raw=z.read(name).decode('utf-8','ignore')
        except KeyError: continue
        p=Para(); p.feed(raw)
        words=sum(len(x.split()) for x in p.paras)
        title=p.head or ''
        if words < min_words or SKIP.match(title): continue
        out.append({'file':name.rsplit('/',1)[-1],'title':title,'paragraphs':p.paras,'words':words})
    return out

def audio_chapters(path, min_dur):
    j=json.loads(subprocess.run(['ffprobe','-v','quiet','-print_format','json','-show_chapters',path],
        capture_output=True,text=True).stdout)
    ch=[{'start':float(c['start_time']),'end':float(c['end_time'])} for c in j['chapters']]
    return [c for c in ch if c['end']-c['start']>=min_dur]

def main():
    epub, audio, outdir = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    min_words = int(sys.argv[4]) if len(sys.argv)>4 else 200
    outdir.mkdir(parents=True, exist_ok=True); os.umask(0o077)
    secs = narrative(epub, min_words)
    chs  = audio_chapters(audio, 60)
    n = min(len(secs), len(chs))
    chapters=[]
    for i in range(n):
        s, c = secs[i], chs[i]
        cid = f'c{i+1:02d}'
        chapters.append({'id':cid,'title':s['title'] or f'Chapter {i+1}','start':c['start'],'end':c['end'],
                         'paragraphs':[{'id':f'{cid}-p{j:04d}','text':t} for j,t in enumerate(s['paragraphs'],1)]})
        f = outdir/f'chapter-{i+1:02d}.txt'
        f.write_text((s['title'] or f'Chapter {i+1}')+'\n'+'\n'.join(s['paragraphs'])+'\n')
        f.chmod(0o600)
    (outdir/'chapters.json').write_text(json.dumps(chapters,ensure_ascii=False,indent=1)+'\n')
    st=os.stat(audio)
    # Content identity only: /mnt/media is mergerfs and renumbers inodes on mount.
    (outdir/'source.json').write_text(json.dumps({'size':st.st_size,'mtimeMs':st.st_mtime_ns/1e6},indent=1)+'\n')
    text='\n'.join(p['text'] for c in chapters for p in c['paragraphs'])
    (outdir/'prepare-summary.json').write_text(json.dumps({
        'textSections':len(secs),'audioChapters':len(chs),'used':n,
        'droppedText':[s['title'][:40] for s in secs[n:]],
        'paragraphs':sum(len(c['paragraphs']) for c in chapters),
        'words':sum(len(p['text'].split()) for c in chapters for p in c['paragraphs']),
        'sourceTextSha256':hashlib.sha256(text.encode()).hexdigest(),
        'sourceEpubSha256':hashlib.sha256(Path(epub).read_bytes()).hexdigest(),
    },indent=1)+'\n')
    print(json.dumps({'textSections':len(secs),'audioChapters':len(chs),'chapters':n,
        'paragraphs':sum(len(c['paragraphs']) for c in chapters),
        'droppedTextTail':[s['title'][:40] for s in secs[n:]],
        'droppedAudioTail':len(chs)-n}, indent=1))
main()
