# REMA v2

We have create a VRT with efficient overviews, so a GDAL-capable software can read any portion very efficiently. 

The DSN is here: 

```
/vsicurl/https://raw.githubusercontent.com/mdsumner/rema-ovr/main/REMA-2m_dem_ovr.vrt 
```

Size is 2725100, 2921100

Thes files are involved along with the 2m DEM tiles of the original 2m VRT. 

```
/vsicurl/https://raw.githubusercontent.com/mdsumner/rema-ovr/main/rema-vrt/10m_dem_tiles.vrt
/vsicurl/https://raw.githubusercontent.com/mdsumner/rema-ovr/main/rema-vrt/32m_dem_tiles.vrt
/vsicurl/https://github.com/mdsumner/rema-ovr/raw/main/rema_mosaic_100m_v2.0_dem_int16.tif
/vsicurl/https://github.com/mdsumner/rema-ovr/raw/main/rema_mosaic_500m_v2.0_filled_cop30_dem.tif
/vsicurl/https://github.com/mdsumner/rema-ovr/raw/main/rema_mosaic_1km_v2.0_filled_cop30_dem.tif
```

The .vrt files are provided by REMA v2 itself. The 500m and 1km tifs are also provided by REMA, but in very slow-to-acccess tarballs. They are copied here. 

The 100m is a conversion of the `rema_mosaic_100m_v2.0_dem.tif` to remove overviews, use sparse tiles, Int16 storage and ZSTD compression so it's small enough for Github. 

We might use the filled_cop30 for the 100m we just got a bit delayed on that. 

