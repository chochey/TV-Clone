// Inventory is a short, independently queued operation. Slow metadata/intro
// work cannot hold its lock, and accepting a request is not completion.
module.exports = function createLibraryRefresh({scan,enrich,now=Date.now,onError=()=>{}}) {
  let running=false,queued=false,enriching=false,pending=null;
  let phase='idle',enrichmentPhase='idle',lastCompletedAt=0,error='',enrichmentError='';
  const status=()=>({running,queued,phase,lastCompletedAt,error,enriching,enrichmentPhase,enrichmentError});
  async function enrichLoop() {
    if (enriching) return;
    enriching=true;
    try {
      while (pending) {
        const library=pending;pending=null;enrichmentError='';
        try { await enrich(library,value=>{enrichmentPhase=value;}); }
        catch(err) {enrichmentError='Background metadata could not finish. You can still browse your library.';onError(err);}
      }
    } finally {enriching=false;enrichmentPhase='idle';}
  }
  async function scanLoop() {
    try {
      do {
        queued=false;phase='Scanning files';error='';
        try {
          const library=await scan();lastCompletedAt=now();pending=library;
          void enrichLoop();
        } catch(err) {error='Library refresh failed. Please try again.';onError(err);}
      } while (queued);
    } finally {running=false;phase='idle';}
  }
  function request() {
    if (running) {queued=true;return {ok:true,queued:true,status:status()};}
    running=true;phase='Scanning files';error='';
    void scanLoop();
    return {ok:true,queued:false,status:status()};
  }
  return {request,status};
};
