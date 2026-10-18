"""Read-only candidate: compare full book context, then score retained timings.
Unlike matching only highlighted words, omitted low-confidence words never break
an otherwise corroborated phrase. Sparse checkpoints remain explicit, and need
two strong separated checkpoints plus >=100 corroborated retained tokens.
"""
import re,difflib,math
import numpy as np
from num2words import num2words

def spoken_tokens(value):
 value=str(value).replace('’',"'").replace('‘',"'")
 def expand(match):
  text=match[0]
  try:return num2words(text[:-2].replace(',',''),to='ordinal') if re.search(r'(st|nd|rd|th)$',text) else num2words(text.replace(',',''))
  except (ValueError,TypeError,NotImplementedError):return text
 value=re.sub(r'\b\d+(?:,\d{3})*(?:\.\d+)?(?:st|nd|rd|th)?\b',expand,value.lower())
 return re.findall(r'[a-z0-9]+',value)

def evaluate(chapter,quality,samples):
 # Compute kept count from candidate, not the pre-filter quality checkpoint.
 kept=sum(len(p.get('words',[])) for p in chapter['paragraphs'])
 source_count=sum(q['words'] for q in quality)
 coverage=kept/max(1,source_count)
 checks=[]
 for label,sample in samples.items():
  sample_tokens=[];times=[]
  for word,at in zip(sample['words'],sample['times']):
   tokens=spoken_tokens(word);sample_tokens.extend(tokens);times.extend([at]*len(tokens))
  if not times:
   checks.append({'sample':label,'status':'failed','reason':'Empty independent sample'});continue
  # Restrict matching to the known paragraph neighborhood; repeated phrases
  # elsewhere in the chapter cannot masquerade as local timing verification.
  source=[];refs=[]
  for paragraph in chapter['paragraphs']:
   if paragraph['end']<min(times)-5 or paragraph['start']>max(times)+5:continue
   spanmap={(a,b):(lo,hi) for a,b,lo,hi in paragraph.get('words',[])}
   for match in re.finditer(r'\S+',paragraph['text']):
    a=len(paragraph['text'][:match.start()].encode('utf-16-le'))//2
    b=len(paragraph['text'][:match.end()].encode('utf-16-le'))//2
    tokens=spoken_tokens(match[0]);source.extend(tokens);refs.extend([spanmap.get((a,b))]*len(tokens))
  matches=[];ambiguous=0
  for block in difflib.SequenceMatcher(a=source,b=sample_tokens,autojunk=False).get_matching_blocks():
   if block.size<3:continue
   for offset in range(block.size):
    sidx=block.a+offset;ridx=block.b+offset;ref=refs[sidx]
    # At either edge of a recognized phrase, a repeated common token beside
    # a large recognition gap can point to either occurrence. Do not let it
    # validate or invalidate timing without neighboring spoken-word context.
    edge=offset in (0,block.size-1)
    before=times[ridx]-times[ridx-1] if ridx>0 else 0
    after=times[ridx+1]-times[ridx] if ridx+1<len(times) else 0
    repeated=source[sidx] in ('the','a','an','and','to','of','in','it','i','he','she','we','you','they')
    if edge and repeated and before>1.5 and after>1.5:
     ambiguous+=1;continue
    matches.append((ref,times[ridx]))
  timed=[max(ref[0]-t,t-ref[1],0) for ref,t in matches if ref is not None]
  full_fraction=len(matches)/max(1,len(sample_tokens))
  timed_fraction=len(timed)/max(1,len(sample_tokens))
  missing=sum(ref is None for ref,t in matches)
  median=float(np.median(timed)) if timed else None;p90=float(np.quantile(timed,.9)) if timed else None
  source_ok=len(matches)>=25 and full_fraction>=.6
  timing_ok=bool(timed) and median<=.2 and p90<=.6
  strong=source_ok and timing_ok and len(timed)>=25 and timed_fraction>=.6
  # A sparse sample is permissible only because highlights were deliberately
  # withheld from a substantial part of its matched source, never because bad
  # timestamps or an unrecognizable passage should be ignored.
  sparse=source_ok and timing_ok and len(timed)>=10 and missing/max(1,len(matches))>=.25
  status='strong' if strong else 'partial' if sparse else 'failed'
  checks.append({'sample':label,'status':status,'matchedWords':len(timed),'matchFraction':round(timed_fraction,3),'sourceMatches':len(matches),'sourceMatchFraction':round(full_fraction,3),'unhighlightedMatches':missing,'ambiguousReferenceTokens':ambiguous,'median':round(median,3) if median is not None else None,'p90':round(p90,3) if p90 is not None else None,'max':round(max(timed),3) if timed else None,'sampleStart':sample['start']})
 strong=[c for c in checks if c['status']=='strong']
 total=sum(c.get('matchedWords',0) for c in checks)
 separation=max((a['sampleStart']-b['sampleStart'] for a in strong for b in strong),default=0)
 allstrong=len(strong)==3 and len(checks)==3
 partialok=len(strong)>=2 and len(checks)==3 and all(c['status'] in ('strong','partial') for c in checks) and total>=100 and separation>=(chapter['end']-chapter['start'])*.25
 return {'ok':coverage>=.8 and (allstrong or partialok),'coverage':round(coverage,4),'independentlyMatchedWords':total,'partialValidation':not allstrong and partialok,'checks':checks}
