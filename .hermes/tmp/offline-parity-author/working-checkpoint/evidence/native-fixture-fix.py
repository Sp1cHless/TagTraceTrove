from guard import *
f='apps/web/tests/fixtures/native-valid-kind-fixture.ts'
edit(f," 'producer.update': {", " 'producer.create': { baseVersion: 0, baseValues: {}, payload: {name:'Standalone',occupation:null,artworkRef:null,content:null} },\n 'producer.delete': { baseVersion: 1, baseValues: {}, payload: {} },\n 'producer.update': {")
