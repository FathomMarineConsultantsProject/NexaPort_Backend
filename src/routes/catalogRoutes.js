import express from 'express';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getCatalogProduct,searchCatalog } from '../services/catalogSearchService.js';
import { requireAuth,allowRoles } from '../middlewares/authMiddleware.js';
import { pool } from '../config/db.js';
const router=express.Router();
router.use(requireAuth,allowRoles(1,2,3,4));
const imageFolder=fileURLToPath(new URL('../../../tools/shipserv_suppliers_directory/output/products/images/',import.meta.url));
router.get('/images/:imageId.png',(req,res)=>{const id=req.params.imageId;if(!/^[0-9a-f]{32}$/.test(id))return res.status(400).end();return res.sendFile(join(imageFolder,`${id}.png`),error=>{if(error&&!res.headersSent)res.status(error.status||404).end()})});
router.get('/search',async(req,res)=>{ try { const q=String(req.query.q||'').trim(); if (q.length<2 || q.length>120) return res.status(400).json({success:false,message:'Search must contain 2 to 120 characters.'}); const page=Math.max(1,Math.min(10000,Number.parseInt(req.query.page,10)||1)); const result=await searchCatalog(q,undefined,page); return res.json({success:true,data:result.rows,pagination:result.pagination,relatedSources:result.relatedSources,relatedPagination:result.relatedPagination}); } catch { return res.status(500).json({success:false,message:'Catalogue search unavailable.'}); } });
router.get('/suppliers/:id',async(req,res)=>{try{
  if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({success:false,message:'Invalid supplier ID.'});
  const result=await pool.query(`SELECT e.id,e.company_name,e.nexaport_company_id,e.city,e.country,e.website
    FROM public.maritime_directory_entities e WHERE e.id=$1 AND e.is_active=true AND e.review_status='approved'
    AND EXISTS(SELECT 1 FROM public.maritime_directory_entity_types t WHERE t.entity_id=e.id AND t.directory_type='supplier')`,[req.params.id]);
  return result.rows[0]?res.json({success:true,data:result.rows[0]}):res.status(404).json({success:false,message:'Supplier not found.'});
}catch{return res.status(500).json({success:false,message:'Supplier profile unavailable.'})}});
router.get('/:id',async(req,res)=>{ try { if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({success:false,message:'Invalid product ID.'}); const page=Math.max(1,Math.min(10000,Number.parseInt(req.query.page,10)||1)),limit=Math.max(1,Math.min(100,Number.parseInt(req.query.limit,10)||25)); const data=await getCatalogProduct(req.params.id,{page,limit}); return data?res.json({success:true,data}):res.status(404).json({success:false,message:'Product not found.'}); } catch { return res.status(500).json({success:false,message:'Catalogue product unavailable.'}); } });
export default router;
