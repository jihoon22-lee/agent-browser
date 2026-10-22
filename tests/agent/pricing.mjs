/** Documentation moved while the installed v1 API contract stayed the same. Follow only
 * official documentation redirects; this never changes the provider or inference endpoint. */
export async function fetchOfficialPricing(fetcher=fetch) {
  let url='https://opencode.ai/docs/zen/';
  for(let n=0;n<4;n++){
    const response=await fetcher(url,{signal:AbortSignal.timeout(15000),redirect:'manual'});
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');
    if(!location)throw new Error('Missing official pricing redirect');
    const next=new URL(location,url);
    if(next.origin!=='https://opencode.ai'||!/^\/(?:v[12]\/)?docs\//.test(next.pathname)||next.username||next.password)throw new Error('Refused a non-official pricing documentation redirect');
    url=next.href;
  }
  throw new Error('Too many official pricing redirects');
}
