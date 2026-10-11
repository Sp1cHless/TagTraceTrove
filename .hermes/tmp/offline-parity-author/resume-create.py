from guard import *
import ast
source=(STAGE/'create-impl.py').read_text()
tree=ast.parse(source)
# Only statements after the already-applied projection/early-return edits.
remaining=[node for node in tree.body if node.lineno>=41]
first=remaining[0]
old=ast.literal_eval(first.value.args[1]);new=ast.literal_eval(first.value.args[2])
old='  async function enqueueProducerProfileUpdate(\n    authorId: number,\n    input: UpdateProducerRequest & { galleryAnchor?: string },\n    transportError?: unknown,\n  ): Promise<Awaited<ReturnType<GalleryApi[\'updateAuthor\']>>> {\n    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;\n    if (!hasOutbox(store)) throw transportError ?? new Error(\'Offline Author profile storage is unavailable\');\n    if (await store.readMeta(PRODUCER_PROFILE_CAPABILITY_KEY) !== \'1\') {\n      throw new Error(\'This offline copy has not enabled offline Author profile editing; update it while online\');\n    }\n'+old
prefix=old[:old.index('    const active')]
first.value.args[1]=ast.Constant(old);first.value.args[2]=ast.Constant(prefix+new)
# Preflight all guarded edits against sequential candidate buffers before writing.
f='apps/web/src/offline/offline-api.ts'
changes=[]
for node in remaining:
 if isinstance(node,ast.Assign): f=ast.literal_eval(node.value)
 elif isinstance(node,ast.Expr) and isinstance(node.value,ast.Call):
  args=node.value.args;changes.append((f,ast.literal_eval(args[1]),ast.literal_eval(args[2])))
candidates={}
for path,a,c in changes:
 b=candidates.get(path,(ROOT/path).read_bytes());matches=[]
 for nl in [b'\n',b'\r\n']:
  x=a.encode().replace(b'\n',nl);y=c.encode().replace(b'\n',nl)
  if b.count(x)==1:matches.append((x,y))
 assert matches,'Preflight missing/nonunique: '+path+' '+a[:90]
 x,y=matches[0];candidates[path]=b.replace(x,y,1)
for path,a,c in changes:edit(path,a,c)
print('Applied remaining create edits only:',len(changes))
