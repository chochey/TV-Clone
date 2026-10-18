from pathlib import Path
import os
os.environ['OMP_NUM_THREADS']='1';os.environ['OPENBLAS_NUM_THREADS']='1'
import sys,json,re,difflib,copy,time
import numpy as np
import align_words as a
from word_validation import evaluate,spoken_tokens
from job_config import ROOT, MODEL
V=json.loads((MODEL/'vocab.json').read_text())
REV={n:c for c,n in V.items()}

def greedy_words(emission,start):
 ids=emission.argmax(axis=1); pieces=[];chars='';frames=[]
 for t,n in enumerate(ids):
  n=int(n)
  if n in (0,1,2,3) or (t and n==ids[t-1]):continue
  c=REV[n]
  if c=='|':
   if chars:pieces.append((chars,start+min(frames)*.02,start+(max(frames)+1)*.02));chars='';frames=[]
  else:chars+=c;frames.append(t)
 if chars:pieces.append((chars,start+min(frames)*.02,start+(max(frames)+1)*.02))
 return pieces

def recover(p,emission,start):
 ids,mapping=a.tokens(p['text'],V)
 if not len(ids):return [],[]
 frames=a.align_ctc(emission,ids); greedy=greedy_words(emission,start)
 expected='|'.join(m[4] for m in mapping).split('|'); decoded=[g[0] for g in greedy]
 matcher=difflib.SequenceMatcher(a=expected,b=decoded,autojunk=False)
 matches=matcher.get_matching_blocks()
 fuzzy={}
 opcodes=matcher.get_opcodes()
 for oi,(tag,i1,i2,j1,j2) in enumerate(opcodes):
  if tag!='replace' or i2-i1!=1 or j2-j1!=1 or not(oi and oi+1<len(opcodes)):continue
  left,right=opcodes[oi-1],opcodes[oi+1]
  if left[0]!='equal' or right[0]!='equal' or left[2]-left[1]<1 or right[2]-right[1]<1 or (left[2]-left[1]+right[2]-right[1])<4:continue
  aa,bb=expected[i1].replace("'",''),decoded[j1].replace("'",'')
  ratio=difflib.SequenceMatcher(a=aa,b=bb,autojunk=False).ratio()
  if len(aa)>=3 and len(bb)>=3 and ratio>=.7:fuzzy[i1]=(j1,ratio)
 supports={i:(b.b+i-b.a,b.size) for b in matches for i in range(b.a,b.a+b.size)}
 fraction=sum(b.size for b in matches)/max(1,len(expected));offset=0;raw=[]
 for ca,cb,begin,end,normal in mapping:
  f=[t for i in range(begin,end) for t in frames[i]]
  score=float(np.exp(np.mean([max(emission[t,ids[i]] for t in frames[i]) for i in range(begin,end) if ids[i]!=V['|']])))
  lo=max(p['start'],start+min(f)*.02-.03); hi=min(p['end'],start+(max(f)+1)*.02+.07)
  pieces=len(normal.split('|')); ix=list(range(offset,offset+pieces));offset+=pieces
  fuzzyWord=pieces==1 and ix[0] in fuzzy
  ratio=0
  supported=all(i in supports for i in ix)
  if supported:
   gi=[supports[i][0] for i in ix]; block=min(supports[i][1] for i in ix)
   supported=gi==list(range(gi[0],gi[0]+len(gi)))
   gl,gh=greedy[gi[0]][1],greedy[gi[-1]][2]
  elif fuzzyWord:
   gi,ratio=fuzzy[ix[0]];gl,gh=greedy[gi][1:];block=0
  else:gl=gh=0;block=0
  near=(supported or fuzzyWord) and max(abs(lo-gl),abs(hi-gh))<=.4 and max(lo-(gl+gh)/2,(gl+gh)/2-hi,0)<=.08
  # Low-confidence words need an exact contiguous greedy phrase at the same
  # time. Isolated high-confidence short paragraphs may match all their text.
  strong=supported and (block>=3 or (fraction==1 and score>=.25))
  accept=score>=.15 and near and strong and fraction>=.45
  raw.append({'span':[ca,cb,round(lo,3),round(hi,3)],'score':score,'greedyMatch':fraction,'supported':supported,'near':near,'block':block,'accept':accept,'normal':normal,'greedySpan':[round(gl,3),round(gh,3)],'fuzzy':fuzzyWord,'similarity':ratio})
 # Trim only recovered candidates against existing timings; never change any
 # existing tuple. Missing-neighbor candidates follow their forced CTC order.
 previous={tuple(w[:2]):w for w in p.get('words',[])}
 additions=[]
 for i,r in enumerate(raw):
  w=r['span']
  if tuple(w[:2]) in previous:continue
  lo=w[2];hi=w[3]
  before=[old for old in p.get('words',[]) if old[1]<=w[0]]
  after=[old for old in p.get('words',[]) if old[0]>=w[1]]
  run=[v for v in raw if (not before or v['span'][0]>=before[-1][1]) and (not after or v['span'][1]<=after[0][0])]
  anchored=bool(before and after and 1<=len(run)<=3 and 0<after[0][2]-before[-1][3]<=2.5 and all(v['score']>=.15 and v['greedyMatch']>=.45 and v['span'][2]>=before[-1][3]-.08 and v['span'][3]<=after[0][2]+.08 for v in run))
  r['anchored']=anchored
  if not r['accept'] and not anchored:continue
  if before:lo=max(lo,before[-1][3])
  if after:hi=min(hi,after[0][2])
  if additions:lo=max(lo,additions[-1][3])
  if i+1<len(raw):hi=min(hi,max(lo,(hi+raw[i+1]['span'][2])/2))
  if .025<=hi-lo<=max(3,(w[1]-w[0])*.3):additions.append([w[0],w[1],round(lo,3),round(hi,3)])
 return additions,raw

def addition_checks(chapter,samples,old):
 outputs=[]
 for label,sample in samples.items():
  st=[];times=[]
  for word,at in zip(sample['words'],sample['times']):
   tok=spoken_tokens(word);st+=tok;times += [at]*len(tok)
  if not times:
   outputs.append({'sample':label,'newMatches':0,'median':None,'p90':None,'max':None,'words':[]});continue
  src=[];refs=[];wordrefs=[]
  for p,op in zip(chapter['paragraphs'],old['paragraphs']):
   if p['end']<min(times)-5 or p['start']>max(times)+5:continue
   oldspans={tuple(w[:2]) for w in op.get('words',[])}
   spans={tuple(w[:2]):w[2:] for w in p.get('words',[]) if tuple(w[:2]) not in oldspans}
   for match in re.finditer(r'\S+',p['text']):
    ca=len(p['text'][:match.start()].encode('utf-16-le'))//2;cb=len(p['text'][:match.end()].encode('utf-16-le'))//2
    toks=spoken_tokens(match[0]);src+=toks;refs += [spans.get((ca,cb))]*len(toks);wordrefs += [match[0]]*len(toks)
  result=[]
  for block in difflib.SequenceMatcher(a=src,b=st,autojunk=False).get_matching_blocks():
   if block.size<3:continue
   for offset in range(block.size):
    si=block.a+offset;ri=block.b+offset;ref=refs[si]
    if ref is None:continue
    before=times[ri]-times[ri-1] if ri else 0;after=times[ri+1]-times[ri] if ri+1<len(times) else 0
    if offset in (0,block.size-1) and src[si] in ('the','a','an','and','to','of','in','it','i','he','she','we','you','they') and before>1.5 and after>1.5:continue
    result.append({'word':wordrefs[si],'interval':ref,'whisper':times[ri],'distance':round(max(ref[0]-times[ri],times[ri]-ref[1],0),3)})
  ds=[r['distance'] for r in result]
  outputs.append({'sample':label,'newMatches':len(ds),'median':float(np.median(ds)) if ds else None,'p90':float(np.quantile(ds,.9)) if ds else None,'max':max(ds) if ds else None,'words':result})
 return outputs
