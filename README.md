# SDx_Bluebeam_Review

Adds the ability to work in bluebeam for review of documents in SDx. It does this by downloading the pdf under review to a local folder of your choosing, from which you open the pdf in bluebeam and add your comments. Then when you save, the script will detect the saved pdf locally and ask if you're ready to import comments.

<img width="954" height="538" alt="image" src="https://github.com/user-attachments/assets/c94e0631-9e4c-4359-8cd5-b67f25fd0b30" />

Button A - 
Exports the pdf (with any existing comments in Sdx if you desire) to the folder of your choosing. Some files may come with security locks in SDx, those are removed in the local download (to allow comments in Bluebeam)
Tracks your saves on the locally saved file. Once you are done commenting in bluebeam, the script will ask you if you are ready to upload at which point it automatically opens the second popup (B) to allow importing comments.

Comments are imported as faithfully as possible using the default SDx comment tools but some unique items like dimension lines with values in bluebeam get translated to lines with a comment embedded for the dim value. 

Any snapshots/images you add in bluebeam get passed on as stamps in SDx, but you can control their transparency. 

Other features:
Folder housekeeping, every filedownloaded has an embedded timestamp in the suffix.
The tool will allow you to delete any local file older than X amount of days. So you don't build up a large repository of local files from SDx. 
If a comment type from bluebeam fails to translate to SDx, the import tool will tell you, so you can try to re-create in SDx. 

<img width="2051" height="1218" alt="image" src="https://github.com/user-attachments/assets/2a6a50e1-a394-4d4a-abf8-b55ec346cefa" />


<img width="900" height="920" alt="image" src="https://github.com/user-attachments/assets/32008770-a083-481b-bf31-91a8dfae8798" />

