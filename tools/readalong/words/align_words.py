from pathlib import Path
import os,json,re,time,subprocess,unicodedata,difflib,sys,hashlib,tempfile
os.environ['OMP_NUM_THREADS']='2';os.environ['OPENBLAS_NUM_THREADS']='1'
import numpy as np
import onnxruntime as ort
from job_config import ROOT,AUDIO,MODEL,assert_job
STEP=.02

def identity():
 # Content only. /mnt/media is a mergerfs union that renumbers inodes (and changes st_dev) on every
 # mount, so comparing dev/ino/ctime made any resume after a reboot fail with 'Audiobook changed'
 # and 'Independent checkpoint source changed' on a file nobody had touched.
 s=AUDIO.stat();return {'size':s.st_size,'mtimeMs':s.st_mtime_ns/1e6}
def same(a,b):return all(abs(a[k]-b[k]) < (1 if k.endswith('Ms') else .1) for k in a)
def atomic(path,value):
 fd,name=tempfile.mkstemp(prefix='.words-',dir=path.parent)
 try:
  with os.fdopen(fd,'w') as f:json.dump(value,f,ensure_ascii=False,separators=(',',':'));f.flush();os.fsync(f.fileno())
  os.chmod(name,0o600);os.replace(name,path)
 finally:
  if os.path.exists(name):os.unlink(name)
def log(**v): print(json.dumps(v),flush=True)

def normalize(value):
 value=value.replace('’',"'").replace('‘',"'")
 # Expand written numbers for matching, while retaining the original display.
 from num2words import num2words
 value=re.sub(r'\b\d+(?:,\d{3})*(?:\.\d+)?(?:st|nd|rd|th)?\b',lambda m:num2words(m[0][:-2].replace(',',''),to='ordinal') if re.search(r'(st|nd|rd|th)$',m[0]) else num2words(m[0].replace(',','')),value)
 value=unicodedata.normalize('NFKD',value).encode('ascii','ignore').decode().upper()
 return re.sub(r"[^A-Z']+",'|',value).strip('|')

def tokens(text,vocab):
 ids=[];mapping=[]
 for match in re.finditer(r'\S+',text):
  word=normalize(match[0]);a=len(text[:match.start()].encode('utf-16-le'))//2;b=len(text[:match.end()].encode('utf-16-le'))//2
  if not word:continue
  if ids:ids.append(vocab['|'])
  begin=len(ids);ids.extend(vocab[c] for c in word);mapping.append((a,b,begin,len(ids),word))
 return np.array(ids,dtype=np.int32),mapping

def align_ctc(emission,ids):
 # Expanded CTC states preserve repeated characters and actual silence.
 states=np.zeros(len(ids)*2+1,dtype=np.int32);states[1::2]=ids
 count=len(states);previous=np.full(count,-np.inf,dtype=np.float32);previous[0]=0
 if count*len(emission)>80_000_000:raise ValueError('Paragraph too large for bounded acoustic alignment')
 skip=np.zeros(count,dtype=bool);skip[2:]=(states[2:]!=0)&(states[2:]!=states[:-2])
 back=np.zeros((len(emission),count),dtype=np.uint8)
 best=-np.inf;finish=None
 for t,frame in enumerate(emission):
  one=np.r_[-np.inf,previous[:-1]];two=np.r_[-np.inf,-np.inf,previous[:-2]];two[~skip]=-np.inf
  choices=np.stack((previous,one,two));direction=choices.argmax(axis=0)
  current=choices[direction,np.arange(count)]+frame[states]
  # Padded leading audio need not belong to this paragraph.
  current[0]=0;back[t]=direction;previous=current
  for end in (count-2,count-1):
   if current[end]>best:best=float(current[end]);finish=(t,end)
 if finish is None or not np.isfinite(best):raise ValueError('No alignment path')
 t,state=finish;frames=[[] for _ in ids]
 while t>=0 and state>0:
  if state%2:frames[state//2].append(t)
  state-=int(back[t,state]);t-=1
 if state>0 or any(not f for f in frames):raise ValueError('Incomplete alignment path')
 return [sorted(f) for f in frames]

def word_timings(paragraph,emission,start,vocab):
 ids,mapping=tokens(paragraph['text'],vocab)
 if len(ids)==0:return [],{'coverage':0,'words':0,'kept':0,'greedyMatch':0,'medianScore':0}
 frames=align_ctc(emission,ids)
 raw=[];scores=[]
 for a,b,begin,end,normal in mapping:
  f=[t for i in range(begin,end) for t in frames[i]]
  # Only voiced character probabilities contribute to confidence, never blanks.
  score=float(np.exp(np.mean([max(emission[t,ids[i]] for t in frames[i]) for i in range(begin,end) if ids[i]!=vocab['|']])))
  lo=max(paragraph['start'],start+min(f)*STEP-.03);hi=min(paragraph['end'],start+(max(f)+1)*STEP+.07)
  scores.append(score)
  raw.append([a,b,round(lo,3),round(hi,3),score,normal])
 # Independent greedy decoding must broadly agree with the book, to catch wrong
 # passages rather than trusting a forced path by itself.
 greedy=emission.argmax(axis=1);reverse={n:c for c,n in vocab.items()}
 decoded=''.join(reverse[int(n)] for t,n in enumerate(greedy) if n not in (0,1,2,3) and (t==0 or n!=greedy[t-1])).split('|')
 expected='|'.join(row[5] for row in raw).split('|')
 matcher=difflib.SequenceMatcher(a=expected,b=decoded,autojunk=False)
 match=sum(block.size for block in matcher.get_matching_blocks())/max(1,len(expected))
 supported=set()
 for block in matcher.get_matching_blocks():supported.update(range(block.a,block.a+block.size))
 words=[];offset=0
 for i,row in enumerate(raw):
  a,b,lo,hi,score,normal=row
  pieces=len(normal.split('|'));supportedWord=all(index in supported for index in range(offset,offset+pieces));offset+=pieces
  if i+1<len(raw) and hi>raw[i+1][2]:hi=max(lo,(hi+raw[i+1][2])/2);raw[i+1][2]=round(hi,3)
  if score>=.15 and (supportedWord or score>=.65) and hi-lo>=.025 and hi-lo<=max(3,(b-a)*.3) and match>=.45:
   words.append([a,b,round(lo,3),round(hi,3)])
 return words,{'coverage':round(len(words)/max(1,len(raw)),3),'greedyMatch':round(match,3),'words':len(raw),'kept':len(words),'medianScore':round(float(np.median(scores)),3)}

class Acoustic:
 def __init__(self):
  config=ort.SessionOptions();config.intra_op_num_threads=2;config.inter_op_num_threads=1
  config.add_session_config_entry('session.intra_op.allow_spinning','0');config.add_session_config_entry('session.inter_op.allow_spinning','0')
  self.session=ort.InferenceSession(str(MODEL/'model_quantized.onnx'),config,providers=['CPUExecutionProvider'])
  self.vocab=json.loads((MODEL/'vocab.json').read_text())
 def infer(self,pcm):
  pcm=(pcm-pcm.mean())/np.sqrt(pcm.var()+1e-7)
  y=self.session.run(None,{'input_values':pcm[None]})[0][0]
  y=y-y.max(-1,keepdims=True);return y-np.log(np.exp(y).sum(-1,keepdims=True))
 def chapter(self,ch,n):
  dest=ROOT/f'emissions-{n:02}.npy'
  if dest.exists():
   try:
    cached=np.load(dest).astype(np.float32)
    assert cached.ndim==2 and cached.shape[1]==32 and np.isfinite(cached).all()
    assert abs(len(cached)-int(np.ceil((ch['end']-ch['start'])/STEP)))<=3
    return cached
   except (ValueError,AssertionError,OSError):dest.unlink(missing_ok=True)
  data=subprocess.check_output(['ffmpeg','-nostdin','-v','error','-ss',str(ch['start']),'-t',str(ch['end']-ch['start']),'-i',str(AUDIO),'-map','0:a:0','-ac','1','-ar','16000','-threads','1','-f','f32le','-'],timeout=180)
  pcm=np.frombuffer(data,dtype=np.float32);duration=len(pcm)/16000;output=np.full((int(np.ceil(duration/STEP)),32),-30,dtype=np.float32);output[:,0]=0
  completed=0;then=time.monotonic()
  for core in np.arange(0,duration,20):
   low=max(0,core-1.5);high=min(duration,core+21.5);y=self.infer(pcm[round(low*16000):round(high*16000)])
   offset=round(low/STEP);indices=np.arange(len(y))+offset
   use=(indices>=round(core/STEP))&(indices<round(min(duration,core+20)/STEP))&(indices<len(output))
   output[indices[use]]=y[use];completed+=1
   if completed%10==0:log(chapter=n,phase='matching speech',audioMinutes=round(min(core+20,duration)/60,1),totalMinutes=round(duration/60,1),elapsedSeconds=round(time.monotonic()-then))
  temp=dest.with_suffix('.tmp')
  with temp.open('wb') as file:np.save(file,output.astype(np.float16));file.flush();os.fsync(file.fileno())
  os.replace(temp,dest);return output

def main():
 os.umask(0o077)
 document=assert_job()
 model=Acoustic();order=[int(x) for x in sys.argv[1:] if x.isdigit()] or list(range(1,len(document['chapters'])+1))
 for n in order:
  ch=document['chapters'][n-1];target=ROOT/f'words-{n:02}.json';then=time.monotonic()
  if not (target.exists() and (ROOT/f'quality-{n:02}.json').exists()):
   emissions=model.chapter(ch,n);results=[];paragraphs=[]
   for p in ch['paragraphs']:
    low=max(0,int((p['start']-ch['start']-.8)/STEP));high=min(len(emissions),int(np.ceil((p['end']-ch['start']+.8)/STEP)))
    try:words,quality=word_timings(p,emissions[low:high],ch['start']+low*STEP,model.vocab)
    except (ValueError,AssertionError) as error:
     words=[];quality={'coverage':0,'words':len(p['text'].split()),'kept':0,'greedyMatch':0,'medianScore':0,'reason':str(error)[:160]}
    q=dict(p)
    if words:q['words']=words
    paragraphs.append(q);results.append({'id':p['id'],**quality})
   value={**ch,'paragraphs':paragraphs}
   atomic(ROOT/f'quality-{n:02}.json',results);atomic(target,value)
  quality=json.loads((ROOT/f'quality-{n:02}.json').read_text())
  coverage=sum(x['kept'] for x in quality)/max(1,sum(x['words'] for x in quality))
  if coverage<.8:log(chapter=n,phase='needs review',coverage=round(coverage,4))
  assert same(identity(),document['source']),'Audiobook changed'
  log(chapter=n,phase='aligned',words=sum(x['kept'] for x in quality),coverage=round(coverage,4),elapsedSeconds=round(time.monotonic()-then,1))


if __name__=='__main__':main()
