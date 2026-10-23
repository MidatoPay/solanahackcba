import React,{createContext,useContext,useState,useCallback,useMemo} from 'react';
const Context=createContext(null);
export function PrivyFixture({children}) {
 const [id,setId]=useState('alice');
 const getAccessToken=useCallback(async()=>`fixture-${id}`,[id]);
 const value=useMemo(()=>({ready:true,authenticated:Boolean(id),user:id?{id:`did:privy:fixture-${id}`,linkedAccounts:[]}:null,
  getAccessToken,logout:async()=>setId(null),login:()=>setId('alice'),setId}),[id,getAccessToken]);
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const usePrivy=()=>useContext(Context);
export const useWallets=()=>({ready:true,wallets:[]});
export const useExportWallet=()=>({exportWallet:async()=>{throw new Error('Fixture cannot export wallets');}});
