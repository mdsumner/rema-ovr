# REMA v2

We have created a VRT with efficient overviews, so a GDAL-capable software can read any portion very efficiently. 

The DSN is here: 

```
/vsicurl/https://raw.githubusercontent.com/mdsumner/rema-ovr/main/REMA-2m_dem_ovr.vrt 
```

Size is 2725100, 2921100

## Examples

Use the warper, it will target the right level of detail. This works as well in Python osgeo.gdal as it does at the command line and in R's terra (there's some gotchas still in terra). 


```R
library(terra)
rema <- rast("/vsicurl/https://raw.githubusercontent.com/mdsumner/rema-ovr/main/REMA-2m_dem_ovr.vrt")
rema
#class       : SpatRaster 
#dimensions  : 2921100, 2725100, 1  (nrow, ncol, nlyr)
#resolution  : 2, 2  (x, y)
#extent      : -2700100, 2750100, -2500100, 3342100  (xmin, xmax, ymin, ymax)
#coord. ref. : WGS 84 / Antarctic Polar Stereographic (EPSG:3031) 
#source      : REMA-2m_dem_ovr.vrt 
#name        : REMA-2m_dem_ovr 

plot(project(rema, rast(), by_util = TRUE))

plot(project(rema, aggregate(rast(rema), 1e4), by_util = TRUE))

```

![image](https://github.com/mdsumner/rema-ovr/assets/4107631/1d257f68-fd3b-4296-9b20-67193031aaf5)


![image](https://github.com/mdsumner/rema-ovr/assets/4107631/869b4426-a8ca-43ba-a3f5-79fe9656df07)


## PS. Don't use these files below, they are fyi

 Use the single-end-point VRT above with the warper :)

These files are involved along with the 2m DEM tiles of the original 2m VRT. 

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

