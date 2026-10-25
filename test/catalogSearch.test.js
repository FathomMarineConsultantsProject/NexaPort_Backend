import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCatalog,getCatalogProduct } from '../src/services/catalogSearchService.js';

test('identifier search keeps ambiguous product matches separate',async()=>{
  const db={query:async(sql,values)=>{if(sql.includes('catalog_candidate_source_mentions')){assert.equal(values[0],'ABC123');return {rows:[{id:'review-1',evidence_state:'document_host_only',total_matches:1}]}}assert.match(sql,/product_identifiers/);assert.equal(values[1],'ABC123');return {rows:[{id:'one',name:'Pump A',exact_match:true},{id:'two',name:'Pump B',exact_match:true}]}}};
  const result=await searchCatalog('abc 123',db);assert.equal(result.rows.length,2);assert.equal(result.relatedSources.length,1);assert.equal(result.relatedPagination.total,1);
});
test('product detail pages verified canonical suppliers and separates external evidence',async()=>{
  const calls=[];const db={query:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith('SELECT * FROM'))return {rows:[{id:'product',name:'Guide'}]};if(sql.includes('FROM public.catalog_suppliers s'))return {rows:[...Array.from({length:15},(_,i)=>({id:`supplier-${i}`,canonical_entity_id:`entity-${i}`,relationships:[{type:'supplier_listing',evidenceClassification:'supplier_catalogue_listing'}]})),{id:'external',canonical_entity_id:null,relationships:[{type:'supplier_listing',evidenceClassification:'supplier_catalogue_listing'}]}]};return {rows:[]}}};
  const result=await getCatalogProduct('product',{page:2,limit:10},db);
  assert.equal(result.supplierCount,15);assert.equal(result.sourceSupplierCount,16);assert.equal(result.pagination.pages,2);assert.equal(result.suppliers.length,5);assert.equal(result.sourceSuppliers.length,1);assert.deepEqual(calls.at(-1).values,['product']);
});
