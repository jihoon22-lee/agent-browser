using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace AgentBrowser.Installer {
    internal sealed class JsonEdit { public string Text,EntryHash; public bool CreatedMcp,Changed; }
    internal static class Jsonc {
        sealed class Token { public string Kind,Raw,Value; public int Start,End; }
        sealed class Property { public string Name; public int Key,First,Last,Before=-1,After=-1; }
        static List<Token> Tokens(string text) {
            var list=new List<Token>();int i=0;
            while(i<text.Length) {
                char ch=text[i]; if(Char.IsWhiteSpace(ch)||ch=='\uFEFF') {i++;continue;}
                if(ch=='/'&&i+1<text.Length) {
                    if(text[i+1]=='/') {i+=2;while(i<text.Length&&text[i]!='\n') i++;continue;}
                    if(text[i+1]=='*') {int end=text.IndexOf("*/",i+2,StringComparison.Ordinal);if(end<0) throw new FormatException("Unterminated JSONC comment.");i=end+2;continue;}
                }
                int start=i;
                if(ch=='"') {
                    i++;bool closed=false;
                    while(i<text.Length) {if(text[i]=='\\') {i+=2;continue;}if(text[i++]=='"') {closed=true;break;}}
                    if(!closed) throw new FormatException("Unterminated JSON string.");
                    string raw=text.Substring(start,i-start);
                    list.Add(new Token{Kind="string",Raw=raw,Value=NativeIO.Json.Deserialize<string>(raw),Start=start,End=i});continue;
                }
                if("{}[]:,".IndexOf(ch)>=0) {i++;list.Add(new Token{Kind=ch.ToString(),Raw=ch.ToString(),Start=start,End=i});continue;}
                var match=Regex.Match(text.Substring(i),@"^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)");
                if(!match.Success) throw new FormatException("Invalid JSON token at "+i+".");
                i+=match.Length;list.Add(new Token{Kind="scalar",Raw=match.Value,Start=start,End=i});
            }
            return list;
        }
        public static string Minify(string text) {
            var tokens=Tokens(text);var output=new StringBuilder();
            for(int i=0;i<tokens.Count;i++) {if(tokens[i].Kind==","&&i+1<tokens.Count&&(tokens[i+1].Kind=="}"||tokens[i+1].Kind=="]")) continue;output.Append(tokens[i].Raw);}
            string value=output.ToString();NativeIO.Json.DeserializeObject(value);return value;
        }
        static int Last(List<Token> t,int start) {
            if(start>=t.Count) throw new FormatException("Missing JSON value.");
            if(t[start].Kind!="{"&&t[start].Kind!="[") return start;
            int depth=0;
            for(int i=start;i<t.Count;i++) {if(t[i].Kind=="{"||t[i].Kind=="[") depth++;if(t[i].Kind=="}"||t[i].Kind=="]") {depth--;if(depth==0) return i;}}
            throw new FormatException("Unclosed JSON value.");
        }
        static List<Property> Properties(List<Token> t,int index) {
            if(t[index].Kind!="{") throw new FormatException("Expected a JSON object.");
            var output=new List<Property>();var seen=new HashSet<string>(StringComparer.Ordinal);int i=index+1,previous=-1;
            while(i<t.Count&&t[i].Kind!="}") {
                if(i+2>=t.Count||t[i].Kind!="string"||t[i+1].Kind!=":") throw new FormatException("Invalid JSON object property.");
                if(!seen.Add(t[i].Value)) throw new FormatException("Duplicate JSON property: "+t[i].Value);
                var p=new Property{Name=t[i].Value,Key=i,First=i+2,Last=Last(t,i+2),Before=previous};
                if(p.Last+1>=t.Count) throw new FormatException("Unclosed JSON object.");
                if(t[p.Last+1].Kind==",") p.After=p.Last+1;
                output.Add(p);i=p.Last+1;
                if(p.After>=0) {previous=p.After;i++;}else if(t[i].Kind!="}") throw new FormatException("Missing JSON object comma.");
            }
            return output;
        }
        static string Insert(string text,List<Token> t,int obj,string key,string value) {
            var properties=Properties(t,obj);int end=Last(t,obj);
            string prefix=properties.Count>0&&t[end-1].Kind!=","?",":"",nl=text.Contains("\r\n")?"\r\n":"\n";
            return text.Insert(t[end].Start,prefix+nl+"  "+NativeIO.Json.Serialize(key)+": "+value+nl);
        }
        static string Remove(string text,List<Token> t,Property p) {
            int start=t[p.Key].Start,end=t[p.Last].End;
            if(p.After>=0) end=t[p.After].End;else if(p.Before>=0) start=t[p.Before].Start;
            return text.Remove(start,end-start);
        }
        public static JsonEdit Edit(string text,object entry,string expected=null,bool remove=false,bool removeEmpty=false) {
            Minify(text);var t=Tokens(text);if(t.Count==0||t[0].Kind!="{") throw new FormatException("OpenCode settings must be an object.");
            var mcp=Properties(t,0).FirstOrDefault(p=>p.Name=="mcp");
            var entries=mcp==null?new List<Property>():Properties(t,mcp.First);
            var browser=entries.FirstOrDefault(p=>p.Name=="browser");string oldHash=null;
            if(browser!=null) {
                oldHash=NativeIO.TextHash(Minify(text.Substring(t[browser.First].Start,t[browser.Last].End-t[browser.First].Start)));
                if(String.IsNullOrEmpty(expected)||oldHash!=expected) throw new InvalidOperationException("mcp.browser belongs to another installation or was changed. No settings were overwritten.");
            } else if(!remove&&!String.IsNullOrEmpty(expected)) throw new InvalidOperationException("The owned mcp.browser entry was removed. Explicitly register it again.");
            string edited=text;string hash=null;bool created=false;
            if(remove) {if(browser!=null) edited=Remove(text,t,removeEmpty&&entries.Count==1?mcp:browser);}
            else {
                string value=NativeIO.Json.Serialize(entry);hash=NativeIO.TextHash(Minify(value));
                if(browser!=null) {if(oldHash!=hash) edited=text.Substring(0,t[browser.First].Start)+value+text.Substring(t[browser.Last].End);}
                else if(mcp!=null) edited=Insert(text,t,mcp.First,"browser",value);
                else {edited=Insert(text,t,0,"mcp","{\"browser\":"+value+"}");created=true;}
            }
            Minify(edited);return new JsonEdit{Text=edited,EntryHash=hash,CreatedMcp=created,Changed=edited!=text};
        }
    }
}

