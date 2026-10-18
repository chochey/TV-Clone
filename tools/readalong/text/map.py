import json, re, subprocess, sys, zipfile, statistics
from xml.etree import ElementTree as E
from html.parser import HTMLParser

class Para(HTMLParser):
    """Collect <p>/<li> text in document order, plus the first heading."""
    def __init__(self):
        super().__init__(); self.paras=[]; self.buf=None; self.head=None; self.hbuf=None
    def handle_starttag(self,tag,attrs):
        if tag in ('p','li'): self.buf=[]
        if tag in ('h1','h2') and self.head is None: self.hbuf=[]
    def handle_endtag(self,tag):
        if tag in ('p','li') and self.buf is not None:
            t=re.sub(r'\s+',' ',''.join(self.buf)).strip()
            if t: self.paras.append(t)
            self.buf=None
        if tag in ('h1','h2') and self.hbuf is not None:
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

def sections(path):
    z=zipfile.ZipFile(path); out=[]
    for name in spine(z):
        try: raw=z.read(name).decode('utf-8','ignore')
        except KeyError: continue
        p=Para(); p.feed(raw)
        words=sum(len(x.split()) for x in p.paras)
        out.append({'file':name.rsplit('/',1)[-1],'title':p.head or '','paras':p.paras,'words':words})
    return out

def audio_chapters(path):
    j=json.loads(subprocess.run(['ffprobe','-v','quiet','-print_format','json','-show_chapters',path],
        capture_output=True,text=True).stdout)
    return [{'start':float(c['start_time']),'end':float(c['end_time']),
             'dur':float(c['end_time'])-float(c['start_time'])} for c in j['chapters']]

epub,audio = sys.argv[1], sys.argv[2]
secs = sections(epub)
chs  = audio_chapters(audio)
narr = [s for s in secs if s['words']>=200]
spoken = [c for c in chs if c['dur']>=60]
print(f"text sections >=200w : {len(narr)}")
print(f"audio chapters >=60s : {len(spoken)}  (dropped {len(chs)-len(spoken)} short/credits)")
n=min(len(narr),len(spoken))
rates=[narr[i]['words']/spoken[i]['dur'] for i in range(n)]
med=statistics.median(rates)
bad=[(i+1,narr[i]['title'][:34],narr[i]['words'],round(spoken[i]['dur']),round(rates[i],2)) for i in range(n)
     if rates[i] < med*0.6 or rates[i] > med*1.6]
print(f"median words/sec     : {med:.2f}")
print(f"outliers (>±40% off) : {len(bad)}")
for b in bad[:12]: print('   idx %-3d %-34r words=%-6d dur=%-5ds rate=%.2f' % b)
