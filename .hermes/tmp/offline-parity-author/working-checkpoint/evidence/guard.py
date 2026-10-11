from pathlib import Path
import hashlib,json
ROOT=Path('D:/Project/TagTraceTrove'); STAGE=ROOT/'.hermes/tmp/offline-parity-author'; STAGE.mkdir(parents=True,exist_ok=True)
LEDGER=STAGE/'ledger.json'
def sha(b): return hashlib.sha256(b).hexdigest()
def edit(path,old,new):
    p=ROOT/path; b=p.read_bytes(); ledger=json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
    if path not in ledger:
        q=STAGE/'before'/path;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
        ledger[path]={'original':sha(b),'current':sha(b),'new':False}
    assert sha(b)==ledger[path]['current'], 'External drift: '+path
    # Match normalized textual anchors while replacing only the matched bytes.
    a=old.encode(); c=new.encode(); matches=[]
    for nl in [b'\n',b'\r\n']:
        x=a.replace(b'\n',nl); y=c.replace(b'\n',nl)
        if b.count(x)==1: matches.append((x,y))
    assert matches, 'Missing/nonunique anchor: '+path+' '+old[:90]
    x,y=matches[0]; candidate=b.replace(x,y,1);p.write_bytes(candidate)
    ledger[path]['current']=sha(candidate);LEDGER.write_text(json.dumps(ledger,indent=2))
def newfile(path,text):
    p=ROOT/path;assert not p.exists(),path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(text.encode())
    ledger=json.loads(LEDGER.read_text()) if LEDGER.exists() else {};ledger[path]={'original':None,'current':sha(p.read_bytes()),'new':True};LEDGER.write_text(json.dumps(ledger,indent=2))
