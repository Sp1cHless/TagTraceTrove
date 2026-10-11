package com.speechless666.t3.spike;

import org.junit.Test;
import static org.junit.Assert.*;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.concurrent.TimeUnit;

/** Typed bridge adapter forwards every JS request to real claimed/pinned native
 * transport. No synthetic bytes, JS-visible credentials or trust bypass. */
public class PairedBootstrapBytesTest {
    @Test public void productionBootstrapVerifierUsesAuthenticatedPinnedOriginalBytes() throws Exception {
        String repository=System.getenv("T3_TEST_REPO"); assertNotNull(repository);
        Process child=new ProcessBuilder("node",Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),Path.of(repository,"apps/server/tests/fixtures/paired-bootstrap-bytes.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        BufferedReader reader=new BufferedReader(new InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8));
        PrintWriter writer=new PrintWriter(child.getOutputStream(),true,StandardCharsets.UTF_8);
        try {
            String qr=reader.readLine();assertNotNull("Isolated authenticated fixture starts",qr);
            PairingState state=PairingState.claim(qr);state.verify();
            state=PairingState.parse(state.serialize().toString()); // native-owned cold credential
            writer.println("{\"ready\":true}");
            int requests=0;boolean done=false;
            for(String line;(line=reader.readLine())!=null;) {
                JSONObject message=new JSONObject(line);
                if(message.optBoolean("done")) {
                    assertTrue(message.toString(),message.getBoolean("pass"));
                    System.out.println("paired-bootstrap-byte-caller "+message);
                    assertTrue(message.getBoolean("wrongMissingRetained"));assertTrue(message.getBoolean("canonicalQuery"));
                    assertEquals(3,message.getInt("unapprovedNotPaired"));assertTrue(message.getInt("rawBytes")>0);
                    assertEquals(requests,message.getInt("bridgeCalls"));done=true;break;
                }
                JSONObject args=message.getJSONObject("request");
                assertFalse("Token never enters JS bridge arguments",args.has("token"));assertFalse(args.has("authorization"));
                assertTrue(args.length()==3 || args.length()==4);
                assertTrue(args.getString("path").startsWith("/api/"));
                // Same authority and transport operations as PairedTransportPlugin.request.
                state.verify();
                byte[] body=args.isNull("body")?null:Base64.getDecoder().decode(args.getString("body"));
                PinnedLanTransport.Result result=state.transport.request(args.getString("path"),args.getString("method"),args.isNull("contentType")?null:args.getString("contentType"),body,state.token);
                JSONObject reply=new JSONObject().put("status",result.status).put("url","https://localhost"+result.path).put("contentType",result.contentType==null?JSONObject.NULL:result.contentType).put("body",Base64.getEncoder().encodeToString(result.bytes));
                assertFalse(reply.toString().contains(state.token));writer.println(reply);requests++;
            }
            assertTrue("Actual JS production caller completed",done);
            assertTrue(child.waitFor(20,TimeUnit.SECONDS));assertEquals(0,child.exitValue());
        } finally {writer.close();if(!child.waitFor(15,TimeUnit.SECONDS))child.destroyForcibly();}
    }
}
